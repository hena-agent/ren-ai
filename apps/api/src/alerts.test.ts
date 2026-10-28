import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { alertRequests, applicationAlerts } from "./alerts.ts";
import { deliverDiscord } from "./metrics/discord.ts";
import { migrate } from "./database.ts";
import type { ApplicationStore } from "./application-store.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(migrate.pipe(Effect.andThen(effect))).pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );

test("alerts are durable, deduplicated and never forward private detail", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("received"));
  await run(
    Effect.gen(function* () {
      const flush = deliverDiscord(
        { alerts: "https://hook.example", reports: undefined },
        fetcher,
        crypto.randomUUID(),
      );
      const alerts = yield* applicationAlerts;
      yield* alerts.raise("bad name", "private prompt");
      yield* alerts.raise("provider-failing", "private prompt");
      yield* alerts.raise("provider-failing");
      yield* alerts.clear("missing");
      yield* flush;
      const restarted = yield* applicationAlerts;
      yield* restarted.raise("provider-failing");
      yield* restarted.clear("provider-failing");
      yield* restarted.clear("provider-failing");
      yield* flush;
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("private prompt");
  expect(fetcher.mock.calls[0]![1]?.body).toContain("알림: provider-failing");
  expect(fetcher.mock.calls[1]![1]?.body).toContain("해제: provider-failing");
  expect(fetcher.mock.calls[0]![1]?.body).toContain("https://admin.renai.im/conversations");
});

test("rejected and failed alert deliveries log safe diagnostics and stay queued for retry", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockRejectedValueOnce("private failure input");
  try {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const alerts = yield* applicationAlerts;
        yield* alerts.raise("executor-unavailable");
        yield* alerts.raise("disk-nearly-full");
        yield* deliverDiscord(
          { alerts: "https://hook.example/private-token", reports: undefined },
          fetcher,
          crypto.randomUUID(),
        );
        expect(yield* sql`SELECT attempts FROM discord_outbox`).toEqual([
          { attempts: 1 },
          { attempts: 1 },
        ]);
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain("discord.delivery");
    expect(logs).toContain("DISCORD_HTTP");
    expect(logs).toContain('\\"upstreamStatus\\":401');
    expect(logs).not.toContain("private failure input");
    expect(logs).not.toContain("private-token");
  } finally {
    stderr.mockRestore();
  }
});

const changes = (alerts: readonly { name: string; raised: boolean }[]) =>
  JSON.stringify({ alerts });

test("monitor reports authenticate, reject malformed changes and commit every change together", async () => {
  await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const context = yield* Effect.context<SqlClient.SqlClient>();
      const store = fromPartial<ApplicationStore>({
        run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.runPromise(Effect.provide(effect, context)),
      });
      const handler = alertRequests(store, "management-secret");
      const report = (body: string, authorization = "Bearer management-secret", method = "POST") =>
        Effect.promise(() =>
          handler(
            new Request("https://app/management/alerts", {
              method,
              headers: { authorization },
              ...(method === "POST" && { body }),
            }),
          ),
        );
      expect((yield* report(changes([]), "Bearer wrong")).status).toBe(401);
      const rejected = yield* report("", "Bearer management-secret", "GET");
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("Allow")).toBe("POST");
      for (const malformed of ["{", JSON.stringify({ alerts: [{ name: "x", raised: "yes" }] })])
        expect((yield* report(malformed)).status).toBe(400);
      const raised = [
        { name: "executor-unavailable", raised: true },
        { name: "disk-nearly-full", raised: true },
      ];
      expect((yield* report(changes(raised))).status).toBe(204);
      expect((yield* report(changes(raised))).status).toBe(204);
      expect(yield* sql`SELECT name FROM application_alert ORDER BY name`).toEqual([
        { name: "disk-nearly-full" },
        { name: "executor-unavailable" },
      ]);
      expect(yield* sql`SELECT COUNT(*) AS queued FROM discord_outbox`).toEqual([{ queued: 2 }]);
      expect(
        (yield* report(changes([{ name: "executor-unavailable", raised: false }]))).status,
      ).toBe(204);
      expect(yield* sql`SELECT name FROM application_alert`).toEqual([
        { name: "disk-nearly-full" },
      ]);
    }),
  );
});
