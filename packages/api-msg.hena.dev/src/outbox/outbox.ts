import { Clock, Effect, PartitionedSemaphore, Random, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { Gestures } from "../gestures/gestures.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import type { Persona } from "../personas/personas.ts";
import { notReacted, notSent, sent } from "../transcript/transcript.ts";
import type { timing } from "../timing/timing.ts";

export const tapbacks = ["love", "like", "dislike", "laugh", "emphasis", "question"] as const;
export type Tapback = (typeof tapbacks)[number];

interface SendRow {
  readonly id: number;
  readonly kind: "text" | "tapback";
  readonly state: string;
  readonly content: string;
  readonly guid: string | null;
  readonly recordedAt: number;
  readonly updatedAt: number;
  readonly toolCallID: string | null;
  readonly late: number;
  readonly notificationPending: number;
}

/** Owns every text attempt, including one left recorded by a crashed process. */
export const outbox = (
  messages: Messages,
  gestures: Gestures,
  personas: ReadonlyMap<string, Pick<Persona, "timeZone">>,
  active: (conversation: Conversation) => Effect.Effect<boolean, Error> = () =>
    Effect.succeed(true),
  pace?: ReturnType<typeof timing>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const locks = yield* PartitionedSemaphore.make<number>({ permits: 1 });
    const inFlight = new Set<number>();
    const reconcile = (conversation: Conversation, row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!row.fromMe || row.handle !== conversation.handle) return false;
        const matches = yield* sql<SendRow>`SELECT id, state, content, guid, late,
          notification_pending AS notificationPending, recorded_at AS recordedAt, updated_at AS updatedAt, tool_call_id AS toolCallID
           FROM send WHERE conversation_id = ${conversation.id} AND kind IN ('text', 'tapback')
          AND (guid = ${row.guid} OR (guid IS NULL AND content = ${row.text}
            AND recorded_at <= ${row.createdAt} AND state IN ('recorded', 'uncertain')))
          ORDER BY CASE WHEN guid = ${row.guid} THEN 0 ELSE 1 END, id LIMIT 1`;
        const match = matches[0];
        if (!match) return false;
        const status = yield* messages
          .sendStatus(row.guid)
          .pipe(Effect.catch(() => Effect.succeed("unknown" as const)));
        if (status !== "unknown") {
          const late = inFlight.has(match.id) ? match.late : 1;
          yield* sql`UPDATE send SET state = ${status}, guid = ${row.guid}, updated_at = ${row.createdAt},
            late = ${late}, notification_pending = CASE WHEN ${late} = 1 THEN 1 ELSE notification_pending END
            WHERE id = ${match.id} AND state IN ('recorded', 'uncertain')`;
        }
        return true;
      });
    const pending = (conversation: Conversation) =>
      Effect.map(
        sql<SendRow>`SELECT id, kind, state, content, guid, late, notification_pending AS notificationPending,
          recorded_at AS recordedAt, updated_at AS updatedAt, tool_call_id AS toolCallID FROM send
          WHERE conversation_id = ${conversation.id} AND (state IN ('recorded', 'uncertain') OR notification_pending = 1)
          ORDER BY id LIMIT 1`,
        (rows) => rows[0],
      );
    const check = (conversation: Conversation, earlier: SendRow) =>
      Effect.gen(function* () {
        const rows = yield* messages.recent(conversation.handle, earlier.recordedAt);
        for (const row of rows) yield* reconcile(conversation, row);
        const state = yield* sql<SendRow>`SELECT id, kind, state, content, guid, late,
              notification_pending AS notificationPending,
              recorded_at AS recordedAt, updated_at AS updatedAt, tool_call_id AS toolCallID
              FROM send WHERE id = ${earlier.id}`;
        return state[0]!;
      });
    const settle = (conversation: Conversation, earlier: SendRow) =>
      Effect.gen(function* () {
        // An imsg send can finish after its process exits. Never issue the next send before
        // checking Messages, even when this record predates the current process.
        let current = yield* check(conversation, earlier);
        if (current.state === "recorded" || current.state === "uncertain") {
          yield* Effect.sleep("3 seconds");
          current = yield* check(conversation, earlier);
          if (
            !(yield* messages.recent(conversation.handle, earlier.recordedAt)).some(
              (row) =>
                row.fromMe &&
                row.text === earlier.content &&
                (!earlier.guid || row.guid === earlier.guid),
            )
          ) {
            yield* sql`UPDATE send SET state = 'failed', late = 1, notification_pending = 1,
              updated_at = ${yield* Clock.currentTimeMillis}
              WHERE id = ${earlier.id} AND state IN ('recorded', 'uncertain')`;
            current = yield* check(conversation, earlier);
          }
        }
        return current;
      });
    const before = (
      conversation: Conversation,
      kind: "text" | "tapback",
      content: string,
      callID: string,
    ) =>
      Effect.gen(function* () {
        const prefix = kind === "tapback" ? notReacted : notSent;
        if (!(yield* active(conversation))) return prefix("this Conversation is unavailable");
        const existing =
          yield* sql`SELECT id FROM send WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
        if (existing.length) return prefix("this call was already recorded");
        const earlier = yield* pending(conversation);
        if (!earlier) return undefined;
        const settled = yield* settle(conversation, earlier);
        if (settled.state === "recorded" || settled.state === "uncertain")
          return prefix("an earlier send is still in doubt");
        yield* sql`UPDATE send SET notification_pending = 0 WHERE id = ${settled.id}`;
        if (settled.state !== "sent" && settled.state !== "delivered") return undefined;
        const at = new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: personas.get(conversation.personaID)!.timeZone,
        }).format(settled.updatedAt);
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
          VALUES (${conversation.handle}, ${conversation.id}, ${kind}, ${content}, ${callID}, 'not_sent', ${now}, ${now})`;
        return prefix(
          `your earlier ${settled.kind === "tapback" ? "tapback" : "message"} "${settled.content}" did go out at ${at}`,
        );
      });
    return {
      reconcile,
      results: (sessionID: string) =>
        sql<SendRow>`SELECT send.id, send.state, send.content, send.guid,
          send.recorded_at AS recordedAt, send.updated_at AS updatedAt, send.late,
          send.notification_pending AS notificationPending,
          send.tool_call_id AS toolCallID FROM send
          JOIN conversation ON conversation.id = send.conversation_id
          WHERE conversation.session_id = ${sessionID} AND send.late = 1
          AND send.state IN ('sent', 'delivered', 'failed') ORDER BY send.id`,
      notice: (handle: string, text: string) =>
        Effect.gen(function* () {
          const blocked = yield* sql`SELECT 1 FROM blocked WHERE handle = ${handle}`;
          if (blocked.length) return;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
            VALUES (${handle}, 'notice', ${text}, 'recorded', ${now}, ${now})`;
          const [record] = yield* sql<{ id: number }>`SELECT id FROM send
            WHERE handle = ${handle} AND kind = 'notice' ORDER BY id DESC LIMIT 1`;
          const outcome = yield* Effect.result(messages.sendText(handle, text));
          const updated = yield* Clock.currentTimeMillis;
          if (Result.isFailure(outcome)) {
            yield* sql`UPDATE send SET state = 'uncertain', updated_at = ${updated} WHERE id = ${record!.id}`;
          } else {
            yield* sql`UPDATE send SET state = 'uncertain', guid = ${outcome.success.guid}, updated_at = ${updated} WHERE id = ${record!.id}`;
          }
        }),
      react: (conversation: Conversation, tapback: Tapback, callID: string, seenGUID?: string) =>
        PartitionedSemaphore.withPermit(
          locks,
          conversation.id,
        )(
          Effect.gen(function* () {
            const stopped = yield* before(conversation, "tapback", tapback, callID);
            if (stopped) return stopped;
            const rows = yield* messages.after(0);
            const latest = rows
              .filter((row) => row.handle === conversation.handle && !row.fromMe)
              .at(-1);
            if (!seenGUID || latest?.guid !== seenGUID)
              return notReacted("a newer message arrived, or there is no message to react to");
            const attempted =
              yield* sql`SELECT id FROM send WHERE conversation_id = ${conversation.id}
            AND kind = 'tapback' AND content = ${tapback} AND target_guid = ${seenGUID} LIMIT 1`;
            if (attempted.length)
              return notReacted("this tapback was already attempted on that message");
            if (!(yield* active(conversation)))
              return notReacted("this Conversation is unavailable");
            const now = yield* Clock.currentTimeMillis;
            yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, target_guid, recorded_at, updated_at)
            VALUES (${conversation.handle}, ${conversation.id}, 'tapback', ${tapback}, ${callID}, 'recorded', ${seenGUID}, ${now}, ${now})`;
            const outcome = yield* Effect.result(gestures.react(conversation.handle, tapback));
            const state = Result.isFailure(outcome) ? "uncertain" : "sent";
            yield* sql`UPDATE send SET state = ${state}, updated_at = ${yield* Clock.currentTimeMillis}
            WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
            if (Result.isFailure(outcome)) return notReacted("send in doubt");
            return `reacted ${tapback}`;
          }),
        ),
      send: (conversation: Conversation, text: string, callID: string) =>
        PartitionedSemaphore.withPermit(
          locks,
          conversation.id,
        )(
          Effect.gen(function* () {
            const stopped = yield* before(conversation, "text", text, callID);
            if (stopped) return stopped;
            const extra = yield* Random.nextBetween(1000, 2000);
            const duration = Math.min(15000, text.length * 250 + extra);
            const typingStarted = yield* Clock.currentTimeMillis;
            const type = gestures.typing(conversation.handle, duration).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  const elapsed = (yield* Clock.currentTimeMillis) - typingStarted;
                  yield* Effect.sleep(Math.max(0, duration - elapsed));
                  return true;
                }),
              ),
            );
            const ready = pace ? yield* pace.during(conversation.id, type) : yield* type;
            if (ready !== true) return notSent("a new message arrived");
            if (!(yield* active(conversation))) return notSent("this Conversation is unavailable");
            const now = yield* Clock.currentTimeMillis;
            yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
            VALUES (${conversation.handle}, ${conversation.id}, 'text', ${text}, ${callID}, 'recorded', ${now}, ${now})`;
            const rows = yield* sql<{
              id: number;
            }>`SELECT id FROM send WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
            const id = rows[0]!.id;
            inFlight.add(id);
            return yield* Effect.gen(function* () {
              const outcome = yield* Effect.result(messages.sendText(conversation.handle, text));
              if (Result.isFailure(outcome)) {
                yield* sql`UPDATE send SET state = 'uncertain', late = 1, notification_pending = 1,
                updated_at = ${yield* Clock.currentTimeMillis} WHERE id = ${id} AND state = 'recorded'`;
                return notSent("send in doubt");
              }
              yield* sql`UPDATE send SET state = 'uncertain', guid = ${outcome.success.guid}, updated_at = ${yield* Clock.currentTimeMillis}
              WHERE id = ${id} AND state = 'recorded'`;
              const observed = yield* messages.recent(conversation.handle, now);
              for (const item of observed) yield* reconcile(conversation, item);
              const row = (yield* sql<SendRow>`SELECT id, state, content, guid, late,
              notification_pending AS notificationPending, recorded_at AS recordedAt,
              updated_at AS updatedAt, tool_call_id AS toolCallID FROM send WHERE id = ${id}`)[0]!;
              if (row.state === "sent" || row.state === "delivered") return sent();
              yield* sql`UPDATE send SET late = 1, notification_pending = 1 WHERE id = ${id}`;
              // The RPC accepted the send; the Messages row is the authority.
              return notSent("send in doubt");
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  inFlight.delete(id);
                }),
              ),
            );
          }),
        ),
    };
  });
