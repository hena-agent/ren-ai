import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { CloudflareConfiguration } from "./cloudflare-config.ts";
import { contactCause, contactLog, contactOperationId } from "./discovery/diagnostics.ts";
import { randomUUID } from "node:crypto";
import { parseHealth } from "@ren-ai/transport/health";
import { changeAlert } from "./metrics/discord.ts";

const Facts = Schema.Struct({
  diskNearlyFull: Schema.Boolean,
  screenLocked: Schema.NullOr(Schema.Boolean),
});

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow health and notification failures into payload-free diagnostics
const diagnose = (cause: unknown, stage: string, durationMs: number) => {
  const root = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  const operationId = contactOperationId(cause);
  contactLog({
    requestId: randomUUID(),
    operation: "api-app.health",
    stage,
    outcome: "failed",
    durationMs,
    level: "error",
    ...contactCause(root),
    ...(operationId && { operationId }),
    ...(root instanceof Error &&
      "status" in root &&
      typeof root.status === "number" && { status: root.status }),
  });
};

export const createExecutionHealth = (
  configuration: CloudflareConfiguration["execution"],
  fetcher: typeof fetch,
  messagingProbe: Effect.Effect<void, Error>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const raise = (name: string, _detail?: string) =>
      changeAlert(name, true).pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
    const clear = (name: string) =>
      changeAlert(name, false).pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
    const executorTick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const [last] = yield* sql<{
        at: number;
      }>`SELECT at FROM application_clock WHERE name = 'health'`;
      if (last && now < last.at + 300_000) return;
      yield* sql`INSERT INTO application_clock (name, at) VALUES ('health', ${now}) ON CONFLICT(name) DO UPDATE SET at = excluded.at`;
      const check = Effect.tryPromise(async (signal) => {
        const response = await fetcher(new URL("/health", configuration.apiMsgUrl), {
          headers: { Authorization: `Bearer ${configuration.managementToken}` },
          signal,
          redirect: "manual",
        });
        if (response.status !== 200 && response.status !== 503)
          throw Object.assign(new Error("Executor health is unavailable"), {
            status: response.status,
            code: "EXECUTOR_HEALTH_HTTP",
          });
        try {
          const body = await response.json();
          const health = parseHealth(body, "api-msg");
          if (response.status !== (health.status === "ready" ? 200 : 503))
            throw new Error("Executor health status is inconsistent");
          return Schema.decodeUnknownSync(Facts)(body);
        } catch (cause) {
          throw Object.assign(new Error("Invalid executor health response", { cause }), {
            status: response.status,
            code: "EXECUTOR_HEALTH_INVALID",
          });
        }
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap((facts) =>
          Effect.all([
            facts.diskNearlyFull ? raise("disk-nearly-full") : clear("disk-nearly-full"),
            facts.screenLocked === null
              ? Effect.void
              : facts.screenLocked
                ? raise("screen-locked")
                : clear("screen-locked"),
            clear("executor-unavailable"),
          ]),
        ),
        Effect.catch((cause) =>
          Effect.map(Clock.currentTimeMillis, (checked) =>
            diagnose(cause, "executor.health", checked - now),
          ).pipe(Effect.andThen(raise("executor-unavailable"))),
        ),
      );
      yield* check;
    });
    const messagingTick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const claimed =
        yield* sql`INSERT INTO application_clock(name, at) VALUES ('messaging-health', ${now + 120_000})
        ON CONFLICT(name) DO UPDATE SET at = excluded.at WHERE at <= ${now} RETURNING at`;
      if (!claimed.length) return;
      const scheduleProbe = (
        due: number,
      ) => sql`INSERT INTO application_work(name, due) VALUES ('messaging-health', ${due})
        ON CONFLICT(name) DO UPDATE SET due = excluded.due, generation = generation + 1`;
      yield* scheduleProbe(now + 120_000);
      const failed = yield* messagingProbe.pipe(
        Effect.timeout("5 seconds"),
        Effect.as(false),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            diagnose(cause, "messaging.probe", (yield* Clock.currentTimeMillis) - now);
            return true;
          }),
        ),
      );
      if (!failed) {
        yield* sql`DELETE FROM application_clock WHERE name = 'messaging.failures'`;
        yield* clear("messaging-unavailable");
        return;
      }
      const [count] = yield* sql<{
        at: number;
      }>`INSERT INTO application_clock(name, at) VALUES ('messaging.failures', 1)
        ON CONFLICT(name) DO UPDATE SET at = MIN(2, at + 1) RETURNING at`;
      yield* sql`UPDATE application_clock SET at = ${now + 20_000} WHERE name = 'messaging-health'`;
      yield* scheduleProbe(now + 20_000);
      if (count!.at >= 2) yield* raise("messaging-unavailable");
    });
    const tick = Effect.all([executorTick, messagingTick], {
      concurrency: "unbounded",
      discard: true,
    });
    return { raise, clear, tick };
  });
