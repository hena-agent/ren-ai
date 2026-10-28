import { randomUUID } from "node:crypto";
import { Clock, Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { contactCause, type ContactLog } from "./diagnostics.ts";

/** The durable registration queue runs this before attempting its waitlist Notification. */
export const checkAvailability = (
  registrationID: string,
  transport: Pick<Effect.Success<ReturnType<typeof remoteMessages>>, "availability">,
  log: ContactLog,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      handle: string;
      status: "available" | "unavailable" | "failed" | null;
    }>`SELECT handle, imessage_status AS status FROM discovery_registration WHERE id = ${registrationID}`;
    if (!row || row.status !== null) return row?.status;
    const started = performance.now();
    const fields = { requestId: randomUUID(), operation: "recipient.availability" };
    const result = yield* transport.availability(row.handle).pipe(
      Effect.timeout("10 seconds"),
      Effect.tapError((cause) =>
        Effect.sync(() =>
          log({
            ...fields,
            ...("requestId" in cause && cause.requestId && { operationId: cause.requestId }),
            stage: "transport.lookup",
            outcome: "failed",
            level: "error",
            durationMs: performance.now() - started,
            ...contactCause(cause),
          }),
        ),
      ),
      Effect.option,
    );
    const status = Option.isNone(result)
      ? "failed"
      : result.value.available
        ? "available"
        : "unavailable";
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE discovery_registration SET imessage_status = ${status}, imessage_checked_at = ${now}
      WHERE id = ${registrationID}`;
    log({
      ...fields,
      ...(Option.isSome(result) && { operationId: result.value.requestId }),
      stage: "complete",
      outcome: status === "failed" ? "failed" : "completed",
      level: "info",
      code: status,
      durationMs: performance.now() - started,
    });
    return status;
  });
