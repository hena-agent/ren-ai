import { Clock, Effect, Queue, Random } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import { checkedPhone } from "../transcript/transcript.ts";

interface Due {
  readonly conversationID: number;
  readonly nextWakeAt: number;
  readonly sessionID: string;
  readonly handle: string;
  readonly personaID: string;
}

const day = 24 * 60 * 60 * 1000;
const next = (start: number, later: boolean) =>
  Effect.map(Random.nextBetween(later ? 3 : 1, later ? 7 : 2), (days) =>
    Math.floor(start + days * day),
  );

export const followUps = (
  active: (conversation: Conversation) => Effect.Effect<boolean, Error>,
  timeZone: (personaID: string) => string,
  prompt: (sessionID: string, id: string, text: string) => Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changed = yield* Queue.unbounded<void>();
    const signal = Queue.offer(changed, undefined).pipe(Effect.asVoid);
    const received = (conversation: Conversation, at: number) =>
      Effect.gen(function* () {
        const wake = yield* next(at, false);
        yield* sql`INSERT INTO follow_up (conversation_id, last_sent_at, next_wake_at)
          VALUES (${conversation.id}, ${at}, ${wake})
          ON CONFLICT(conversation_id) DO UPDATE SET last_sent_at = excluded.last_sent_at,
            next_wake_at = excluded.next_wake_at, unanswered = 0, wake_pending = 0, followed_up = 0`;
        yield* signal;
      });
    const sent = (conversation: Conversation, at?: number) =>
      Effect.gen(function* () {
        const now = at ?? (yield* Clock.currentTimeMillis);
        const [row] = yield* sql<{ wakePending: number; followedUp: number; unanswered: number }>`
          SELECT wake_pending AS wakePending, followed_up AS followedUp, unanswered
          FROM follow_up WHERE conversation_id = ${conversation.id}`;
        if (!row) return;
        const first = row.wakePending === 1 && row.followedUp === 0;
        const unanswered = row.unanswered + (first ? 1 : 0);
        const wake = unanswered >= 2 ? null : yield* next(now, row.wakePending === 1);
        yield* sql`UPDATE follow_up SET last_sent_at = ${now}, next_wake_at = ${wake},
          unanswered = ${unanswered}, followed_up = ${row.wakePending === 1 ? 1 : 0}
          WHERE conversation_id = ${conversation.id}`;
        yield* signal;
      });
    // Upgrade existing Conversations without requiring him to text again.
    yield* Effect.gen(function* () {
      const missing = yield* sql<{ id: number; at: number }>`
        SELECT conversation.id, MAX(user.replied_at, COALESCE(intake_last.date, 0),
          COALESCE((SELECT MAX(recorded_at) FROM send WHERE conversation_id = conversation.id
            AND state IN ('sent', 'delivered')), 0)) AS at
        FROM conversation JOIN user ON user.id = conversation.user_id
        LEFT JOIN intake_last ON intake_last.conversation_id = conversation.id
        LEFT JOIN follow_up ON follow_up.conversation_id = conversation.id
        WHERE user.replied_at IS NOT NULL AND follow_up.conversation_id IS NULL`;
      for (const row of missing) {
        const wake = yield* next(row.at, false);
        yield* sql`INSERT OR IGNORE INTO follow_up (conversation_id, last_sent_at, next_wake_at)
          VALUES (${row.id}, ${row.at}, ${wake})`;
      }
    }).pipe(sql.withTransaction);
    const monitor = Effect.forever(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [due] = yield* sql<Due>`SELECT follow_up.conversation_id AS conversationID,
          follow_up.next_wake_at AS nextWakeAt, conversation.session_id AS sessionID,
          user.handle, conversation.persona_id AS personaID FROM follow_up
          JOIN conversation ON conversation.id = follow_up.conversation_id
          JOIN user ON user.id = conversation.user_id
          WHERE follow_up.next_wake_at IS NOT NULL AND user.replied_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM blocked WHERE blocked.handle = user.handle)
          ORDER BY follow_up.next_wake_at LIMIT 1`;
        if (!due) {
          yield* Queue.take(changed);
          return;
        }
        if (due.nextWakeAt > now) {
          yield* Effect.race(Effect.sleep(due.nextWakeAt - now), Queue.take(changed));
          return;
        }
        const conversation: Conversation = {
          id: due.conversationID,
          sessionID: due.sessionID,
          handle: due.handle,
          personaID: due.personaID,
        };
        if (!(yield* active(conversation))) {
          yield* Effect.sleep("1 second");
          return;
        }
        // The ID is stable if prompt admission fails and the server restarts.
        yield* prompt(
          due.sessionID,
          `msg_checked_${due.conversationID}_${due.nextWakeAt}`,
          checkedPhone(now, timeZone(due.personaID)),
        );
        const wake = yield* next(now, true);
        yield* sql`UPDATE follow_up SET next_wake_at = ${wake}, wake_pending = 1,
          followed_up = 0 WHERE conversation_id = ${due.conversationID}
          AND next_wake_at = ${due.nextWakeAt}`;
      }),
    );
    return { received, sent, monitor };
  });
