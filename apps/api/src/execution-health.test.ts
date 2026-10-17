import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { createExecutionHealth } from "./execution-health.ts";
import { migrate } from "./database.ts";

const configuration = {
  apiMsgUrl: "https://executor.example",
  openCodeUrl: "https://executor.example/opencode",
  imsgRpcUrl: "https://executor.example/imsg/rpc",
  managementToken: "management-secret",
  model: "test",
  directory: "/srv/ren-ai",
};
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(migrate.pipe(Effect.andThen(effect))).pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );

test("alerts are durable, deduplicated and never forward private detail", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
  await run(
    Effect.gen(function* () {
      const health = yield* createExecutionHealth(configuration, "https://hook.example", fetcher);
      yield* health.raise("bad name", "private prompt");
      yield* health.raise("provider-failing", "private prompt");
      yield* health.raise("provider-failing");
      yield* health.clear("missing");
      const restarted = yield* createExecutionHealth(
        configuration,
        "https://hook.example",
        fetcher,
      );
      yield* restarted.raise("provider-failing");
      yield* restarted.clear("provider-failing");
      yield* restarted.clear("provider-failing");
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("private prompt");
  expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([
    JSON.stringify({ content: "Alert: provider-failing" }),
    JSON.stringify({ content: "Cleared: provider-failing" }),
  ]);
});

test("health checks are rate limited and keep native facts separate from credentials", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        service: "api-msg",
        revision: "development",
        status: "degraded",
        diskNearlyFull: true,
        screenLocked: true,
      },
      { status: 503 },
    ),
  );
  await run(
    Effect.gen(function* () {
      const health = yield* createExecutionHealth(configuration, undefined, fetcher);
      yield* health.tick;
      yield* health.tick;
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT name FROM application_alert ORDER BY name`).toEqual([
        { name: "disk-nearly-full" },
        { name: "screen-locked" },
      ]);
      const docker = yield* createExecutionHealth(configuration, undefined, fetcher);
      fetcher.mockResolvedValue(
        Response.json({
          service: "api-msg",
          revision: "development",
          status: "ready",
          diskNearlyFull: false,
          screenLocked: null,
        }),
      );
      yield* docker.tick;
      expect(fetcher).toHaveBeenCalledOnce();
      yield* TestClock.adjust("5 minutes");
      yield* docker.tick;
      expect(yield* sql`SELECT name FROM application_alert`).toEqual([{ name: "screen-locked" }]);
      const restarted = yield* createExecutionHealth(configuration, undefined, fetcher);
      fetcher.mockResolvedValue(
        Response.json({
          service: "api-msg",
          revision: "development",
          status: "ready",
          diskNearlyFull: false,
          screenLocked: false,
        }),
      );
      yield* TestClock.adjust("5 minutes");
      yield* restarted.tick;
      expect(yield* sql`SELECT name FROM application_alert`).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[0]![1]?.headers).toEqual({ Authorization: "Bearer management-secret" });
});

test.each([502, 503, 200])(
  "health HTTP %s and notification failures record safe diagnostics before recovery",
  async (status) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        status === 200
          ? Response.json({ service: "api-msg", revision: "development", status: "degraded" })
          : new Response(null, { status }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValueOnce("private failure input");
    try {
      await run(
        Effect.gen(function* () {
          const health = yield* createExecutionHealth(
            configuration,
            "https://hook.example",
            fetcher,
          );
          yield* health.tick;
          yield* health.raise("other-alert");
          const sql = yield* SqlClient.SqlClient;
          expect(
            yield* sql`SELECT name FROM application_alert WHERE name = 'executor-unavailable'`,
          ).toHaveLength(1);
        }),
      );
      const logs = JSON.stringify(stderr.mock.calls);
      expect(logs).toContain("executor.health");
      expect(logs).toContain("alert.delivery");
      expect(logs).toContain(`\\"status\\":${status}`);
      expect(logs).not.toContain("management-secret");
      expect(logs).not.toContain("private failure input");
    } finally {
      stderr.mockRestore();
    }
  },
);
