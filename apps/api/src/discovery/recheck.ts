import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ContactRecheck } from "@ren-ai/onboarding";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { checkAvailability } from "./availability.ts";
import { contactCause, contactLog, type ContactLog } from "./diagnostics.ts";

/** Called after the execution runtime's management authorization, without booting persona work. */
export async function recheckRequest(
  request: Request,
  messages: Pick<Effect.Success<ReturnType<typeof remoteMessages>>, "availability">,
  run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>,
  log: ContactLog = contactLog,
) {
  const requestId = randomUUID();
  const started = performance.now();
  const respond = (status: number, error?: string) => {
    log({
      requestId,
      operation: "recipient.recheck",
      stage: "request",
      status,
      outcome: "completed",
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      durationMs: performance.now() - started,
    });
    return Response.json(
      { ...(error && { error }), requestId },
      {
        status,
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
      },
    );
  };
  if (request.method !== "POST") return respond(405, "method_not_allowed");
  let input: typeof ContactRecheck.Type;
  try {
    input = Schema.decodeUnknownSync(ContactRecheck)(await request.json());
  } catch {
    return respond(400, "invalid_request");
  }
  try {
    const status = await run(
      checkAvailability(input.registrationID, messages, log, true, requestId),
    );
    return status === undefined ? respond(404, "not_found") : respond(200);
  } catch (cause) {
    log({
      requestId,
      operation: "recipient.recheck",
      stage: "lookup.persist",
      outcome: "failed",
      level: "error",
      durationMs: performance.now() - started,
      ...contactCause(cause),
    });
    return respond(503, "recheck_failed");
  }
}
