import {
  bindings,
  controls,
  fetcher,
  settledRuntime,
  storage,
  type RuntimeDouble,
} from "../test/cloudflare-app.test-helper.ts";
import { fromPartial } from "@total-typescript/shoehorn";
import { Deferred, Effect, Exit } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, test, vi } from "vitest";
import { createCloudflareApplication } from "./cloudflare-app.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import { applicationGateway } from "./opencode/application-gateway.ts";
import { applicationApi } from "./opencode/application-protocol.ts";
import { rpcClient } from "@ren-ai/transport/client";
import type { MessagingTools } from "./application-tools.ts";
import { captureGatewayLogs, gatewayFixture } from "../../imsg/test/gateway.test-helper.ts";
import { captureDiagnostics } from "../test/diagnostics.test-helper.ts";

test("a ready database and executor cannot hide APNs failure, and the Mac diagnostic remains correlated", async () => {
  const gateway = gatewayFixture();
  gateway.gestures.gestures.probe = () =>
    Effect.fail(Object.assign(new Error("private Apple detail"), { code: "APNS_UNAVAILABLE" }));
  const { logs, restore } = captureDiagnostics();
  const mac = captureGatewayLogs();
  const app = await createCloudflareApplication(
    storage,
    { ...bindings, TOKEN_MANAGEMENT: "secret" },
    "rules",
    (input, init) => {
      const request = new Request(input, init);
      return request.method === "POST"
        ? gateway.transport.fetch(new Request(new URL("/rpc", request.url), request))
        : fetcher(request);
    },
  );
  try {
    const response = await app.fetch(new Request("https://app/health"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      database: "ready",
      executor: { status: "ready" },
      messaging: "unavailable",
    });
    const diagnostic = logs.find((line) => line.includes('"stage":"messaging.probe"'))!;
    expect(diagnostic).toContain(response.headers.get("x-request-id"));
    expect(diagnostic).toContain('"operationId":');
    expect(mac.logs.join("")).toContain("APNS_UNAVAILABLE");
    expect(mac.logs.join("")).toContain(/"operationId":"([0-9a-f-]{36})"/.exec(diagnostic)![1]);
    expect(logs.join("")).not.toMatch(/private Apple detail|management-token|private-conversation/);
  } finally {
    await app.close();
    await gateway.server.dispose();
    mac.restore();
    restore();
  }
});

test("serves safe health, holds registry writes in bootstrap and closes its scopes", async () => {
  const app = await createCloudflareApplication(storage, bindings, "rules", fetcher);
  expect(app.store).toBeDefined();
  expect(app.configuration.bootstrapOnly).toBe(true);
  const health = await app.fetch(new Request("https://api-app.example/health"));
  expect(await health.json()).toEqual({
    service: "api-app",
    revision: "development",
    status: "degraded",
    database: "ready",
    storage: "durable-object-sqlite",
    bootstrapOnly: true,
    executor: { service: "api-msg", revision: "development", status: "ready" },
    messaging: "ready",
    discordAlerts: "unconfigured",
    discordReports: "unconfigured",
  });
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(
    (await app.fetch(new Request("https://api-app.example/management/state/export"))).status,
  ).toBe(401);
  const completeBody = vi.fn<() => void>();
  const rejectedBody = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode("private registration"));
      completeBody.mockImplementation(() => controller.close());
    },
  });
  const diagnostics = captureDiagnostics();
  let responseSent = false;
  const pending = app
    .fetch(
      new Request("https://api-app.example/discovery/waitlist", {
        method: "POST",
        body: rejectedBody,
        duplex: "half",
      }),
    )
    .then((response) => {
      responseSent = true;
      return response;
    })
    .finally(diagnostics.restore);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(responseSent).toBe(false);
  completeBody();
  const rejected = await pending;
  expect(rejected.status).toBe(503);
  expect(await rejected.json()).toEqual({ error: "bootstrap_only" });
  expect(diagnostics.logs.join("\n")).toContain('"code":"BOOTSTRAP_ONLY"');
  expect(diagnostics.logs.join("\n")).toContain(rejected.headers.get("x-request-id"));
  expect(diagnostics.logs.join("\n")).not.toContain("private registration");
  for (const path of ["/management/discovery/select", "/management/discovery/start", "/unknown"]) {
    const response = await app.fetch(
      new Request(`https://api-app.example${path}`, { method: "POST" }),
    );
    expect(response.status).toBe(503);
  }
  expect(
    await (
      await app.fetch(new Request("https://api-app.example/discovery/personas?locale=ko"))
    ).text(),
  ).toBe("registry");
  expect(
    await (
      await app.fetch(
        new Request("https://api-app.example/discovery/personas?locale=ko", { method: "HEAD" }),
      )
    ).text(),
  ).toBe("registry");
  expect(
    await (
      await app.fetch(
        new Request("https://api-app.example/discovery/waitlist", { method: "OPTIONS" }),
      )
    ).text(),
  ).toBe("registry");
  for (const path of ["/discovery/profiles", "/discovery/reselection/personas"])
    expect(
      (
        await app.fetch(
          new Request(`https://api-app.example${path}`, {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(200);
  expect(controls.storeHandler).toHaveBeenCalledTimes(5);
  expect((await app.fetch(new Request("https://api-app.example/rpc"))).status).toBe(503);
  expect((await app.fetch(new Request("https://api-app.example/operator/users"))).status).toBe(503);
  expect(
    (
      await app.fetch(
        new Request("https://api-app.example/management/catalog/refresh", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
  await app.tick(crypto.randomUUID(), true);
  expect(controls.runtime).not.toHaveBeenCalled();
  await app.close();
  expect(controls.closeStore).toHaveBeenCalledTimes(1);
});

test.each([undefined, "https://discord.example/reports"])(
  "Report webhook %s independently controls readiness",
  async (reports) => {
    const app = await createCloudflareApplication(
      storage,
      {
        ...bindings,
        DISCORD_ALERT_WEBHOOK_URL: "https://discord.example/alerts",
        ...(reports && { DISCORD_REPORT_WEBHOOK_URL: reports }),
      },
      "rules",
      fetcher,
    );
    try {
      const response = await app.fetch(new Request("https://app/health"));
      expect(response.status).toBe(reports ? 200 : 503);
      expect(await response.json()).toMatchObject({
        status: reports ? "ready" : "degraded",
        discordAlerts: "accepting",
        discordReports: reports ? "accepting" : "unconfigured",
      });
    } finally {
      await app.close();
    }
  },
);

test("a ready executor cannot conceal an unavailable application database", async () => {
  controls.failDatabase = true;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const app = await createCloudflareApplication(storage, bindings, "rules", fetcher);
  try {
    const response = await app.fetch(new Request("https://api-app.example/health"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      service: "api-app",
      revision: "development",
      status: "degraded",
      database: "unavailable",
      storage: "durable-object-sqlite",
      bootstrapOnly: true,
      executor: { service: "api-msg", revision: "development", status: "ready" },
      messaging: "ready",
      discordAlerts: "unavailable",
      discordReports: "unavailable",
    });
    const logs = JSON.stringify(stderr.mock.calls);
    expect(logs).toContain(response.headers.get("x-request-id"));
    expect(logs).toContain("database_probe_failed");
    expect(logs).not.toContain("private database detail");
  } finally {
    stderr.mockRestore();
    await app.close();
  }
});

test("registry remains usable with execution down; the next alarm retries execution, not SQLite", async () => {
  const app = await createCloudflareApplication(storage, executionBindings, "rules", fetcher);
  expect((await app.fetch(new Request("https://app/discovery/personas?locale=ko"))).status).toBe(
    200,
  );
  expect(controls.runtime).not.toHaveBeenCalled();
  controls.runtime.mockImplementationOnce(() => {
    throw new Error("scope allocation failed");
  });
  await expect(app.tick(crypto.randomUUID(), true)).rejects.toThrow("scope allocation failed");
  controls.runtime.mockClear();
  controls.runtime.mockRejectedValueOnce(new Error("Mac down"));
  expect((await app.fetch(new Request("https://app/operator/users"))).status).toBe(503);
  await expect(app.tick(crypto.randomUUID(), true)).rejects.toThrow("Mac down");
  expect(controls.closeStore).not.toHaveBeenCalled();
  expect((await app.fetch(new Request("https://app/management/discovery"))).status).toBe(200);
  await app.tick(crypto.randomUUID(), true);
  expect(controls.runtime).toHaveBeenCalledTimes(2);
  const runtime = settledRuntime();
  expect(runtime.tick).toHaveBeenCalledOnce();
  expect((await app.fetch(new Request("https://app/rpc"))).status).toBe(200);
  expect((await app.fetch(new Request("https://app/operator/users"))).status).toBe(200);
  expect(runtime.fetch).toHaveBeenCalledTimes(2);
  expect(
    (await app.fetch(new Request("https://app/management/catalog/refresh", { method: "POST" })))
      .status,
  ).toBe(200);
  expect(runtime.fetch.mock.calls.at(-1)![0].url).toBe("https://app/management/catalog/refresh");
  runtime.initialized = false;
  runtime.tick.mockRejectedValue(new Error("startup failed"));
  runtime.close.mockRejectedValueOnce(new Error("cleanup failed"));
  const startupFailures = await Promise.allSettled([
    app.tick(crypto.randomUUID(), true),
    app.tick(crypto.randomUUID(), true),
  ]);
  expect(startupFailures).toEqual([
    { status: "rejected", reason: new Error("startup failed") },
    { status: "rejected", reason: new Error("startup failed") },
  ]);
  expect(runtime.close).toHaveBeenCalledOnce();
  expect(controls.closeStore).not.toHaveBeenCalled();
  await app.tick(crypto.randomUUID(), true);
  await app.close();
  expect(controls.closeStore).toHaveBeenCalledOnce();
});

test("a failed heartbeat preserves an active send RPC and retries on the same initialized runtime", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const send = vi.fn<MessagingTools["send"]>(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return "sent";
    }),
  );
  const gateway = applicationGateway(fromPartial({ send }), fromPartial({}), "management-secret");
  const runtime: RuntimeDouble = {
    initialized: true,
    fetch: vi.fn<typeof gateway.handler>(gateway.handler),
    tick: vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("heartbeat dependency failed"))
      .mockResolvedValue(undefined),
    close: vi.fn<typeof gateway.dispose>(gateway.dispose),
  };
  controls.runtime.mockResolvedValueOnce(runtime);
  const app = await createCloudflareApplication(storage, executionBindings, "rules", fetcher);
  try {
    const pending = Effect.runPromiseExit(
      Effect.gen(function* () {
        const client = yield* rpcClient(applicationApi, {
          url: "https://app/rpc",
          token: "management-secret",
        });
        return yield* client.send({
          sessionID: "ses_active",
          text: "hello",
          callID: "send-once",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
          app.fetch(new Request(input, init)),
        ),
        Effect.timeout("2 seconds"),
      ),
    );
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("2 seconds")));
    await expect(app.tick(crypto.randomUUID(), true)).rejects.toThrow(
      "heartbeat dependency failed",
    );
    await Effect.runPromise(Deferred.succeed(release, undefined));
    expect(await pending).toEqual(Exit.succeed("sent"));
    expect(runtime.close).not.toHaveBeenCalled();
    await app.tick(crypto.randomUUID(), true);
    expect(runtime.tick).toHaveBeenCalledTimes(2);
    expect(controls.runtime).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledExactlyOnceWith("ses_active", "hello", "send-once");
  } finally {
    await app.close();
    await gateway.dispose();
  }
  expect(runtime.close).toHaveBeenCalledOnce();
});

test.each([200, 401])(
  "executor HTTP %s failures remain separate from database readiness",
  async (status) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const app = await createCloudflareApplication(storage, bindings, "rules", async () =>
      Response.json(
        {
          service: "old-app",
          revision: "development",
          status: "ready",
          private: "private-marker",
        },
        { status },
      ),
    );
    try {
      const response = await app.fetch(new Request("https://api-app.example/health"));
      expect(response.status).toBe(503);
      expect(response.headers.get("x-request-id")).toBeTruthy();
      expect(await response.json()).toEqual({
        service: "api-app",
        revision: "development",
        status: "degraded",
        database: "ready",
        storage: "durable-object-sqlite",
        bootstrapOnly: true,
        executor: { status: status === 401 ? "unauthorized" : "unexpected_response" },
        messaging: "unavailable",
        discordAlerts: "unconfigured",
        discordReports: "unconfigured",
      });
      expect(JSON.stringify(stderr.mock.calls)).toContain(response.headers.get("x-request-id"));
      expect(JSON.stringify(stderr.mock.calls)).toContain(
        status === 401 ? "executor_unauthorized" : "executor_unexpected_response",
      );
      expect(JSON.stringify(stderr.mock.calls)).not.toContain("private-marker");
      expect(
        (await app.fetch(new Request("https://api-app.example/discovery/personas?locale=ko")))
          .status,
      ).toBe(200);
      expect(controls.runtime).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      await app.close();
    }
  },
);

test("closes the SQL store even when execution scope cleanup rejects", async () => {
  const app = await createCloudflareApplication(storage, executionBindings, "rules", fetcher);
  await app.tick(crypto.randomUUID(), true);
  const runtime = settledRuntime();
  runtime.close.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(app.close()).rejects.toThrow("cleanup failed");
  expect(controls.closeStore).toHaveBeenCalledOnce();
});

test("passes writes after explicit activation and closes HTTP resources after a store error", async () => {
  const app = await createCloudflareApplication(
    storage,
    { ...bindings, BOOTSTRAP_ONLY: "false" },
    "rules",
    fetcher,
  );
  expect(
    await app.fetch(new Request("https://api-app.example/discovery/waitlist", { method: "POST" })),
  ).toHaveProperty("status", 200);
  await app.close();

  controls.failStore = true;
  await expect(createCloudflareApplication(storage, bindings, "rules", fetcher)).rejects.toThrow(
    "registry startup failed",
  );
});
