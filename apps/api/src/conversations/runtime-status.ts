import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Session } from "@opencode/schema/session";
import { ConversationRecovery, type ConversationRuntime } from "@ren-ai/onboarding";
import { MissingSession, type PersonaRuntime } from "../opencode/runtime.ts";
import type { conversationEndings } from "./end.ts";
import { conversationRequest } from "./http.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { RecoveryConflict } from "./recover.ts";

export const runtimeStatus = (
  host: PersonaRuntime,
  active: (id: Session.ID) => Effect.Effect<boolean, Error>,
  endings: Effect.Success<ReturnType<typeof conversationEndings>>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inspect = (
      id: number,
      requestId: string = randomUUID(),
    ): Effect.Effect<typeof ConversationRuntime.Type | undefined, Error> =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          sessionID: string;
          nextWakeAt: number | null;
        }>`SELECT c.session_id AS sessionID,
      f.next_wake_at AS nextWakeAt FROM conversation c LEFT JOIN follow_up f ON f.conversation_id = c.id WHERE c.id = ${id}`;
        if (!row) return undefined;
        const sessionID = Session.ID.make(row.sessionID);
        const result = yield* Effect.result(
          Effect.gen(function* () {
            const session = yield* host.sessions.get(sessionID);
            const running = yield* active(sessionID);
            const inbox = yield* host.sessions.inbox(sessionID);
            return {
              state: running ? ("running" as const) : ("idle" as const),
              failed: !running && session.outcome === "failed",
              pending: inbox.length,
              nextWakeAt: row.nextWakeAt,
            };
          }).pipe(Effect.timeout("3 seconds")),
        );
        if (Result.isSuccess(result)) {
          yield* endings.observe(id, requestId).pipe(
            Effect.timeout("1 second"),
            Effect.catch((cause) =>
              Effect.sync(() =>
                contactLog({
                  requestId,
                  operation: "conversation.runtime",
                  stage: "ending.observe",
                  outcome: "failed",
                  level: "error",
                  durationMs: 0,
                  ...contactCause(cause),
                }),
              ),
            ),
          );
          return result.success;
        }
        if (result.failure instanceof MissingSession)
          return { state: "missing", pending: null, nextWakeAt: row.nextWakeAt };
        contactLog({
          requestId,
          operation: "conversation.runtime",
          stage: "session.inspect",
          outcome: "failed",
          level: "error",
          durationMs: 0,
          ...contactCause(result.failure),
        });
        return { state: "unavailable", pending: null, nextWakeAt: row.nextWakeAt };
      });
    return { inspect, recover: endings.recover };
  });

export const runtimeStatusRequest =
  (
    service: Effect.Success<ReturnType<typeof runtimeStatus>>,
    run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  ) =>
  (request: Request) =>
    conversationRequest(request, async (requestId) => {
      if (request.method === "GET") {
        const id = Number(new URL(request.url).searchParams.get("id"));
        if (!Number.isSafeInteger(id) || id <= 0)
          return Response.json({ error: "invalid_id" }, { status: 400 });
        const result = await run(service.inspect(id, requestId));
        return Response.json(result ?? { error: "not_found" }, { status: result ? 200 : 404 });
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      let input: typeof ConversationRecovery.Type;
      try {
        input = Schema.decodeUnknownSync(ConversationRecovery)(await request.json());
      } catch {
        return Response.json({ error: "invalid_recovery" }, { status: 400 });
      }
      const result = await run(Effect.result(service.recover(input)));
      if (Result.isFailure(result)) {
        if (!(result.failure instanceof RecoveryConflict)) throw result.failure;
        contactLog({
          requestId,
          operation: "conversation.recover",
          stage: "recovery.commit",
          outcome: "failed",
          level: "warn",
          durationMs: 0,
          ...contactCause(result.failure),
        });
        return Response.json({ error: "recovery_conflict" }, { status: 409 });
      }
      return Response.json({ queued: true });
    });
