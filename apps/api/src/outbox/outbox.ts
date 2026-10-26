import { Clock, Effect, PartitionedSemaphore, Random, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { Gestures, IncomingMessage, Messages } from "@ren-ai/imsg";
import type { Tapback } from "@ren-ai/imsg/protocol";
import type { Persona } from "@ren-ai/personas";
import { notReacted, notSent, sent } from "../transcript/transcript.ts";
import type { timing } from "../timing/timing.ts";
import { introduceRelationship } from "../conversations/introduction.ts";
import { observeSend } from "./observe.ts";

export type { Tapback } from "@ren-ai/imsg/protocol";

interface SendRow {
  readonly id: number;
  readonly kind: "text" | "tapback" | "photo";
  readonly state: "recorded" | "uncertain" | "sent" | "delivered" | "failed" | "not_sent";
  readonly content: string;
  readonly guid: string | null;
  readonly attemptID: string | null;
  readonly recordedAt: number;
  readonly updatedAt: number;
  readonly toolCallID: string | null;
  readonly late: number;
  readonly notificationPending: number;
}

const photoCancelled =
  "a new message arrived. Keep this photo and read the new messages. You may send it within its expiry if it still fits the conversation; do not explain the delay. Do not repeat successful sends.";

/** Owns every send attempt, including one left recorded by a crashed process. */
export const outbox = (
  messages: Messages,
  gestures: Gestures,
  personas: ReadonlyMap<string, Pick<Persona, "timeZone">>,
  active: (conversation: Conversation) => Effect.Effect<boolean, Error> = () =>
    Effect.succeed(true),
  pace?: Effect.Success<typeof timing>,
  { reportLate = true, typing = true }: { reportLate?: boolean; typing?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const locks = yield* PartitionedSemaphore.make<number>({ permits: 1 });
    const inFlight = new Set<number>();
    const sentListeners = new Set<(conversation: Conversation) => Effect.Effect<void, Error>>();
    const notifySent = (conversation: Conversation) =>
      Effect.forEach(sentListeners, (listener) => listener(conversation)).pipe(Effect.asVoid);
    const recordAttempt = (
      conversation: Conversation,
      kind: SendRow["kind"],
      content: string,
      callID: string,
      targetGUID: string | null = null,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const attemptID = kind === "tapback" ? null : crypto.randomUUID().toUpperCase();
        // Fence the send in the same statement that records it: reset may race typing.
        const rows = yield* sql<{
          id: number;
          recordedAt: number;
          attemptID: string | null;
        }>`INSERT INTO send
        (handle, conversation_id, kind, content, tool_call_id, state, target_guid, recorded_at, updated_at, attempt_id, guid)
        SELECT ${conversation.handle}, id, ${kind}, ${content}, ${callID}, 'recorded', ${targetGUID}, ${now}, ${now}, ${attemptID}, ${attemptID}
        FROM conversation WHERE id = ${conversation.id} AND session_id = ${conversation.sessionID}
          AND rebuilding = 0 AND NOT EXISTS (SELECT 1 FROM blocked WHERE handle = ${conversation.handle})
          AND (ended_at IS NULL OR EXISTS (SELECT 1 FROM conversation_end e
            WHERE e.conversation_id = conversation.id AND e.consumed_at IS NULL
             AND ${callID} = e.call_id || ':farewell:' || e.farewell_attempt AND e.farewell_pending = 1 AND ${content} = e.farewell))
        RETURNING id, recorded_at AS recordedAt, attempt_id AS attemptID`;
        return rows[0];
      });
    const settle = (
      conversation: Conversation,
      match: SendRow,
      guid: string,
      at: number,
      observed?: "sent" | "delivered" | "failed" | "unknown",
    ) =>
      Effect.gen(function* () {
        const status =
          observed ??
          (yield* messages
            .sendStatus(guid)
            .pipe(Effect.catch(() => Effect.succeed("unknown" as const))));
        if (status !== "unknown") {
          const late = inFlight.has(match.id) ? match.late : 1;
          const updated =
            yield* sql`UPDATE send SET state = ${status}, guid = ${guid}, updated_at = ${at},
            late = ${late}, notification_pending = CASE WHEN ${late} = 1 THEN 1 ELSE notification_pending END
            WHERE id = ${match.id} AND state IN ('recorded', 'uncertain') RETURNING id`;
          if (updated.length && status !== "failed") yield* notifySent(conversation);
        }
      });
    const reconcile = (conversation: Conversation, row: IncomingMessage) =>
      Effect.gen(function* () {
        if (!row.fromMe || row.handle !== conversation.handle) return false;
        const matches =
          yield* sql<SendRow>`SELECT id, state, content, guid, attempt_id AS attemptID, late,
          notification_pending AS notificationPending, recorded_at AS recordedAt, updated_at AS updatedAt, tool_call_id AS toolCallID
           FROM send WHERE conversation_id = ${conversation.id} AND kind IN ('text', 'tapback', 'photo')
          AND (guid = ${row.guid} OR (kind != 'photo' AND guid IS NULL AND content = ${row.text}
            AND recorded_at <= ${row.createdAt} AND state IN ('recorded', 'uncertain')))
          ORDER BY CASE WHEN guid = ${row.guid} THEN 0 ELSE 1 END, id LIMIT 1`;
        const match = matches[0];
        if (!match) return false;
        yield* settle(conversation, match, row.guid, row.createdAt);
        return true;
      });
    const pending = (conversation: Conversation) =>
      Effect.map(
        sql<SendRow>`SELECT id, kind, state, content, guid, attempt_id AS attemptID, late, notification_pending AS notificationPending,
          recorded_at AS recordedAt, updated_at AS updatedAt, tool_call_id AS toolCallID FROM send
          WHERE conversation_id = ${conversation.id} AND (state IN ('recorded', 'uncertain') OR notification_pending = 1)
          ORDER BY id LIMIT 1`,
        (rows) => rows[0],
      );
    const check = (conversation: Conversation, earlier: SendRow) =>
      Effect.gen(function* () {
        if (earlier.attemptID && !inFlight.has(earlier.id)) {
          const status = yield* observeSend(
            "transport.resolve",
            earlier.attemptID,
            messages.resolveSend(earlier.attemptID),
          );
          yield* settle(
            conversation,
            earlier,
            earlier.attemptID,
            yield* Clock.currentTimeMillis,
            status,
          );
        } else if (earlier.guid && inFlight.has(earlier.id))
          yield* settle(conversation, earlier, earlier.guid, earlier.recordedAt);
        else {
          const rows = yield* messages.recent(conversation.handle, earlier.recordedAt);
          for (const row of rows) yield* reconcile(conversation, row);
        }
        const state =
          yield* sql<SendRow>`SELECT id, kind, state, content, guid, attempt_id AS attemptID, late,
              notification_pending AS notificationPending,
              recorded_at AS recordedAt, updated_at AS updatedAt, tool_call_id AS toolCallID
              FROM send WHERE id = ${earlier.id}`;
        return state[0]!;
      });
    const before = (
      conversation: Conversation,
      kind: SendRow["kind"],
      content: string,
      callID: string,
    ) =>
      Effect.gen(function* () {
        const prefix = kind === "tapback" ? notReacted : notSent;
        if (!(yield* active(conversation))) return prefix("this Conversation is unavailable");
        const existing =
          yield* sql`SELECT id FROM send WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
        if (existing.length) return prefix("this call was already recorded");
        if (!reportLate) return undefined;
        for (;;) {
          const earlier = yield* pending(conversation);
          if (!earlier) return undefined;
          // A missing row is not a rejection; only an observed outcome releases this fence.
          const settled = yield* check(conversation, earlier);
          if (settled.state === "recorded" || settled.state === "uncertain")
            return prefix("an earlier send is still in doubt");
          yield* sql`UPDATE send SET notification_pending = 0 WHERE id = ${settled.id}`;
          if (settled.state !== "sent" && settled.state !== "delivered") continue;
          const at = new Intl.DateTimeFormat("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: personas.get(conversation.personaID)!.timeZone,
          }).format(settled.updatedAt);
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
          VALUES (${conversation.handle}, ${conversation.id}, ${kind}, ${content}, ${callID}, 'not_sent', ${now}, ${now})`;
          return prefix(
            `your earlier ${settled.kind === "photo" ? "photo" : settled.kind === "tapback" ? "tapback" : "message"} "${settled.content}" did go out at ${at}`,
          );
        }
      });
    const recordedCall = (conversation: Conversation, callID: string) =>
      Effect.map(
        sql<SendRow>`SELECT id, kind, state, content, guid, attempt_id AS attemptID, late,
        notification_pending AS notificationPending, recorded_at AS recordedAt,
        updated_at AS updatedAt, tool_call_id AS toolCallID FROM send
        WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`,
        (rows) => rows[0],
      );
    const sendText = (
      conversation: Conversation,
      text: string,
      callID: string,
      cancelled?: string,
    ) =>
      Effect.gen(function* () {
        const stopped = yield* before(conversation, "text", text, callID);
        if (stopped) return stopped;
        const extra = yield* Random.nextBetween(1000, 2000);
        const duration = Math.min(15000, text.length * 250 + extra);
        const type = Effect.gen(function* () {
          if (pace) yield* pace.quiet(conversation.sessionID);
          const typingStarted = yield* Clock.currentTimeMillis;
          return yield* gestures.typing(conversation.handle, text, duration).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const elapsed = (yield* Clock.currentTimeMillis) - typingStarted;
                yield* Effect.sleep(Math.max(0, duration - elapsed));
                return true;
              }),
            ),
          );
        });
        const ready = !typing
          ? true
          : pace
            ? yield* pace.during(conversation.sessionID, type)
            : yield* type;
        if (ready !== true)
          return notSent(
            cancelled ??
              "a new message arrived. Discard this unsent draft and its unsent continuation; the User never received it. Do not resume, paraphrase, or explain it later, or save it to Memory as a conversation, promise, or pending message. Read the new messages and respond to the current conversation. Revisit that topic only if the User explicitly brings it back. Do not repeat successful sends.",
          );
        return yield* submit(conversation, "text", text, callID, text);
      });
    const submit = (
      conversation: Conversation,
      kind: "text" | "photo",
      content: string,
      callID: string,
      payload: string,
    ) =>
      Effect.gen(function* () {
        const recorded = yield* recordAttempt(conversation, kind, content, callID);
        if (!recorded) return notSent("this Conversation is unavailable");
        const { id } = recorded;
        inFlight.add(id);
        return yield* Effect.gen(function* () {
          const outcome = yield* Effect.result(
            observeSend(
              "transport.submit",
              recorded.attemptID!,
              kind === "photo"
                ? messages.sendPhoto(conversation.handle, payload, recorded.attemptID!)
                : messages.sendText(conversation.handle, payload, recorded.attemptID!),
            ),
          );
          if (Result.isFailure(outcome)) {
            yield* sql`UPDATE send SET state = 'uncertain', late = 1, notification_pending = 1,
            updated_at = ${yield* Clock.currentTimeMillis} WHERE id = ${id} AND state = 'recorded'`;
            return notSent("send in doubt");
          }
          yield* sql`UPDATE send SET state = 'uncertain', updated_at = ${yield* Clock.currentTimeMillis}
          WHERE id = ${id} AND state = 'recorded'`;
          let row =
            (yield* sql<SendRow>`SELECT id, state, content, guid, attempt_id AS attemptID, late,
           notification_pending AS notificationPending, recorded_at AS recordedAt,
            updated_at AS updatedAt, tool_call_id AS toolCallID FROM send WHERE id = ${id}`)[0]!;
          row = yield* check(conversation, row);
          for (let attempt = 0; attempt < 15 && row.state === "uncertain"; attempt++) {
            // imsg can accept a send before Messages exposes its row.
            yield* Effect.sleep("200 millis");
            row = yield* check(conversation, row);
          }
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
      });
    const withIntroduction = (
      conversation: Conversation,
      action: Effect.Effect<string, Error>,
      cancelled?: string,
    ) =>
      PartitionedSemaphore.withPermit(
        locks,
        conversation.id,
      )(
        Effect.gen(function* () {
          const introduction = yield* introduceRelationship(conversation).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (introduction) {
            const result = yield* sendText(
              conversation,
              introduction,
              "relationship-introduction",
              cancelled,
            );
            if (result !== sent()) return result;
          }
          return yield* action;
        }),
      );
    return {
      reconcile,
      observe: (conversation: Conversation) =>
        Effect.gen(function* () {
          const row = yield* pending(conversation);
          if (row?.state === "recorded" || row?.state === "uncertain")
            yield* check(conversation, row);
        }),
      /** An explicit operator-confirmed outcome for legacy attempts; identified sends require transport proof. */
      release: (conversation: Conversation, callID: string, outcome: "failed" | "delivered") =>
        PartitionedSemaphore.withPermit(
          locks,
          conversation.id,
        )(
          Effect.gen(function* () {
            const row = yield* recordedCall(conversation, callID);
            if (!row) return "not_found" as const;
            if (row.state !== "recorded" && row.state !== "uncertain") return "settled" as const;
            const observed = yield* check(conversation, row);
            if (observed.state !== "recorded" && observed.state !== "uncertain")
              return "settled" as const;
            if (row.attemptID) return "uncertain" as const;
            const at = outcome === "delivered" ? row.recordedAt : yield* Clock.currentTimeMillis;
            const released =
              yield* sql`UPDATE send SET state = ${outcome}, late = 1, notification_pending = 1,
            updated_at = ${at} WHERE id = ${row.id}
            AND state IN ('recorded', 'uncertain') RETURNING id`;
            if (released.length && outcome === "delivered") yield* notifySent(conversation);
            return released.length ? ("released" as const) : ("settled" as const);
          }),
        ),
      exclusive: <A, E>(conversation: Conversation, action: Effect.Effect<A, E>) =>
        PartitionedSemaphore.withPermit(locks, conversation.id)(action),
      delivery: (conversation: Conversation, callID: string) =>
        Effect.gen(function* () {
          const row = yield* recordedCall(conversation, callID);
          if (!row) return undefined;
          if (row.state === "recorded" || row.state === "uncertain")
            return (yield* check(conversation, row)).state;
          return row.state;
        }),
      onSent: (listener: (conversation: Conversation) => Effect.Effect<void, Error>) => {
        sentListeners.add(listener);
      },
      results: (sessionID: string) =>
        sql<SendRow>`SELECT send.id, send.kind, send.state, send.content, send.guid,
          send.recorded_at AS recordedAt, send.updated_at AS updatedAt, send.late,
          send.notification_pending AS notificationPending,
          send.tool_call_id AS toolCallID FROM send
          JOIN conversation ON conversation.id = send.conversation_id
          WHERE conversation.session_id = ${sessionID} AND send.late = 1
          AND send.state IN ('sent', 'delivered', 'failed') ORDER BY send.id`,
      react: (conversation: Conversation, tapback: Tapback, callID: string, seenGUID?: string) =>
        PartitionedSemaphore.withPermit(
          locks,
          conversation.id,
        )(
          Effect.gen(function* () {
            const stopped = yield* before(conversation, "tapback", tapback, callID);
            if (stopped) return stopped;
            const [latest] = yield* messages.recent(conversation.handle, 0, {
              limit: 1,
              reverse: true,
            });
            if (!seenGUID || latest?.fromMe !== false || latest.tapback || latest.guid !== seenGUID)
              return notReacted("the latest message is not the one of his you saw");
            const attempted =
              yield* sql`SELECT id FROM send WHERE conversation_id = ${conversation.id}
            AND kind = 'tapback' AND content = ${tapback} AND target_guid = ${seenGUID} LIMIT 1`;
            if (attempted.length)
              return notReacted("this tapback was already attempted on that message");
            if (!(yield* recordAttempt(conversation, "tapback", tapback, callID, seenGUID)))
              return notReacted("this Conversation is unavailable");
            const outcome = yield* Effect.result(gestures.react(conversation.handle, tapback));
            const state = Result.isFailure(outcome) ? "uncertain" : "sent";
            yield* sql`UPDATE send SET state = ${state}, updated_at = ${yield* Clock.currentTimeMillis}
            WHERE conversation_id = ${conversation.id} AND tool_call_id = ${callID}`;
            if (Result.isFailure(outcome)) return notReacted("send in doubt");
            yield* notifySent(conversation);
            return `reacted ${tapback}`;
          }),
        ),
      send: (conversation: Conversation, body: string, callID: string) =>
        withIntroduction(conversation, sendText(conversation, body, callID)),
      sendPhoto: (
        conversation: Conversation,
        photoID: string,
        callID: string,
        load: () => Effect.Effect<string | undefined, Error>,
      ) =>
        withIntroduction(
          conversation,
          Effect.gen(function* () {
            const stopped = yield* before(conversation, "photo", photoID, callID);
            if (stopped) return stopped;
            const prepare = Effect.gen(function* () {
              if (pace) yield* pace.quiet(conversation.sessionID);
              // Pacing races successes: carry loader failures out rather than waiting for an arrival.
              return yield* Effect.result(load());
            });
            const ready = pace
              ? yield* pace.during(conversation.sessionID, prepare)
              : yield* prepare;
            if (ready === "new") return notSent(photoCancelled);
            if (Result.isFailure(ready)) return yield* Effect.fail(ready.failure);
            if (ready.success === undefined)
              return notSent("this photo is unavailable, expired, or already attempted");
            return yield* submit(conversation, "photo", photoID, callID, ready.success);
          }),
          photoCancelled,
        ),
    };
  });
