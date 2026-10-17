import { randomUUID } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SelectContacts } from "@ren-ai/onboarding";
import { parseConversationState, languageSummary } from "@ren-ai/personas";
import type { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import { contactCause, contactLog } from "./diagnostics.ts";
import type { ContactLog } from "./diagnostics.ts";

/** Called only behind the executor's management-token authentication. */
export const conversationLanguages =
  (
    read: (sessionID: string) => Effect.Effect<typeof folderSnapshot.Type, Error>,
    log: ContactLog = contactLog,
  ) =>
  (request: Request) =>
    Effect.gen(function* () {
      const requestId = randomUUID();
      const began = performance.now();
      let registrationID: string;
      try {
        registrationID = Schema.decodeUnknownSync(SelectContacts.fields.requestId)(
          new URL(request.url).searchParams.get("registrationID"),
        );
      } catch {
        log({
          requestId,
          operation: "conversation.languages",
          stage: "input",
          outcome: "failed",
          level: "warn",
          code: "invalid_registration",
          durationMs: performance.now() - began,
        });
        return Response.json(
          { error: "invalid_registration", requestId },
          { status: 400, headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } },
        );
      }
      const result = yield* Effect.result(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{ sessionID: string }>`SELECT c.session_id AS sessionID
      FROM discovery_registration r JOIN user u ON u.handle = r.handle
      JOIN conversation c ON c.user_id = u.id WHERE r.id = ${registrationID} AND r.archived_at IS NULL AND c.ended_at IS NULL`;
          if (!row) return undefined;
          const snapshot = yield* read(row.sessionID);
          const languages = yield* Effect.try(() => {
            const state =
              snapshot.runtime?.state ??
              (snapshot.documents ? parseConversationState(snapshot.documents.state) : undefined);
            return languageSummary(snapshot.persona.prompt, state?.languageProficiency);
          });
          const change = snapshot.runtime?.stateChange;
          return {
            ...(languages && { languages }),
            ...(change && { lastStateChange: { reason: change.reason, at: change.at } }),
          };
        }),
      );
      const failed = Result.isFailure(result);
      log({
        requestId,
        operation: "conversation.languages",
        stage: "state.read",
        outcome: failed ? "failed" : "completed",
        level: failed ? "error" : "info",
        durationMs: performance.now() - began,
        ...(failed && contactCause(result.failure)),
      });
      return Response.json(
        failed
          ? { error: "state_unavailable", requestId }
          : (result.success ?? { error: "conversation_not_found", requestId }),
        {
          status: failed ? 503 : result.success ? 200 : 404,
          headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
        },
      );
    });
