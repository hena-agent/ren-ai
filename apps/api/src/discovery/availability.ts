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
  recheck = false,
  requestId = randomUUID(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      handle: string;
      status: "available" | "unavailable" | "failed" | null;
    }>`SELECT handle, imessage_status AS status FROM discovery_registration WHERE id = ${registrationID}`;
    if (!row || (!recheck && row.status !== null)) return row?.status;
    let reason: string | null = null;
    const started = performance.now();
    const fields = { requestId, operation: "recipient.availability" };
    const result = yield* transport.availability(row.handle).pipe(
      Effect.timeout("10 seconds"),
      Effect.tapError((cause) =>
        Effect.sync(() => {
          const detail = /\[stage=([a-z_]{1,80});code=([a-zA-Z0-9_-]{1,80})\]/.exec(cause.message);
          reason =
            cause.name === "TimeoutError"
              ? "조회 제한 시간(10초)을 초과했습니다."
              : detail
                ? `iMessage 조회 오류: ${detail[1]} / ${detail[2]}`
                : "메시징 서비스 조회에 실패했습니다. 연결 상태를 확인한 뒤 재확인해 주세요.";
          log({
            ...fields,
            ...("requestId" in cause && cause.requestId && { operationId: cause.requestId }),
            stage: "transport.lookup",
            outcome: "failed",
            level: "error",
            durationMs: performance.now() - started,
            ...contactCause(cause),
          });
        }),
      ),
      Effect.option,
    );
    const status = Option.isNone(result)
      ? "failed"
      : result.value.available
        ? "available"
        : "unavailable";
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE discovery_registration SET imessage_status = ${status}, imessage_checked_at = ${now}, imessage_reason = ${reason}
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
