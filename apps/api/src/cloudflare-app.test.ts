import { fromPartial } from "@total-typescript/shoehorn";
import { Deferred, Effect, Exit, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { afterEach, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import { createCloudflareApplication } from "./cloudflare-app.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import { applicationGateway } from "./opencode/application-gateway.ts";
import { applicationApi } from "./opencode/application-protocol.ts";
import { rpcClient } from "@ren-ai/transport/client";
import type { MessagingTools } from "./application-tools.ts";
import { captureGatewayLogs, gatewayFixture } from "../../imsg/test/gateway.test-helper.ts";
import { captureDiagnostics } from "../test/diagnostics.test-helper.ts";

type RuntimeDouble = {
  initialized: boolean;
  fetch: Mock<(request: Request) => Promise<Response>>;
  tick: Mock<() => Promise<void>>;
  close: Mock<() => Promise<void>>;
};

const controls = vi.hoisted(() => ({
  failStore: false,
  failDatabase: false,
  storeRun: vi.fn<() => Promise<void>>(async () => {
    if (controls.failDatabase) throw new Error("private database detail");
  }),
  storeHandler: vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("registry"),
  ),
  closeStore: vi.fn<() => Promise<void>>(async () => undefined),
  runtime: vi.fn<() => Promise<RuntimeDouble>>(async () => ({
    initialized: true,
    fetch: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("execution")),
    tick: vi.fn<() => Promise<void>>(async () => {}),
    close: vi.fn<() => Promise<void>>(async () => {}),
  })),
}));

vi.mock("./execution-runtime.ts", () => ({ createExecutionRuntime: controls.runtime }));

vi.mock("./application-store.ts", () => ({
  createApplicationStore: async () => {
    if (controls.failStore) throw new Error("registry startup failed");
    return {
      run: async (effect: Effect.Effect<void, Error, SqlClient.SqlClient>) => {
        await controls.storeRun();
        return Effect.runPromise(
          Effect.scoped(effect).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
        );
      },
      handler: controls.storeHandler,
      close: controls.closeStore,
    };
  },
}));

const storage = fromPartial<DurableObjectStorage>({ sql: { exec: vi.fn<() => never>() } });
const bindings: CloudflareBindings = {
  PERSONA_CATALOG_URL: "https://admin.example",
  TOKEN_CATALOG: "catalog-token",
  TURNSTILE_SECRET: "turnstile-secret",
  TOKEN_MANAGEMENT: "management-token",
  API_MSG_URL: "https://api-msg.example",
};
const fetcher: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method === "POST") {
    const body = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
    )(await request.text());
    return new Response(
      `${JSON.stringify({ _tag: "Exit", requestId: body.id, exit: { _tag: "Success", value: null } })}\n`,
    );
  }
  return Response.json({ service: "api-msg", revision: "development", status: "ready" });
};
const settledRuntime = () => {
  const result = controls.runtime.mock.settledResults.at(-1);
  if (result?.type !== "fulfilled") throw new Error("Execution did not open");
  return result.value;
};

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

test("an unconfigured management boundary cannot expose edit baselines or accept wake hints", async () => {
  const app = await createCloudflareApplication(
    storage,
    { ...bindings, TOKEN_MANAGEMENT: "", BOOTSTRAP_ONLY: "false" },
    "rules",
    fetcher,
  );
  try {
    expect((await app.fetch(new Request("https://app/management/intake/watch"))).status).toBe(503);
    expect(
      (await app.fetch(new Request("https://app/management/intake/wake", { method: "POST" })))
        .status,
    ).toBe(503);
  } finally {
    await app.close();
  }
});

afterEach(() => {
  controls.failStore = false;
  controls.failDatabase = false;
  controls.storeRun.mockClear();
  controls.storeHandler.mockClear();
  controls.closeStore.mockClear();
  controls.runtime.mockClear();
});

test("serves safe health, holds registry writes in bootstrap and closes its scopes", async () => {
  const app = await createCloudflareApplication(storage, bindings, "rules", fetcher);
  expect(app.store).toBeDefined();
  expect(app.configuration.bootstrapOnly).toBe(true);
  const health = await app.fetch(new Request("https://api-app.example/health"));
  expect(await health.json()).toEqual({
    service: "api-app",
    revision: "development",
    status: "ready",
    database: "ready",
    storage: "durable-object-sqlite",
    bootstrapOnly: true,
    executor: { service: "api-msg", revision: "development", status: "ready" },
    messaging: "ready",
  });
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(
    (await app.fetch(new Request("https://api-app.example/management/state/export"))).status,
  ).toBe(401);
  expect(
    (await app.fetch(new Request("https://api-app.example/discovery/waitlist", { method: "POST" })))
      .status,
  ).toBe(503);
  expect(
    (
      await app.fetch(
        new Request("https://api-app.example/management/discovery/select", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
  expect(
    (
      await app.fetch(
        new Request("https://api-app.example/management/discovery/start", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
  const unrecognizedWrite = await app.fetch(
    new Request("https://api-app.example/unknown", { method: "POST" }),
  );
  expect(unrecognizedWrite.status).toBe(503);
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
  expect(controls.storeHandler).toHaveBeenCalledTimes(3);
  expect((await app.fetch(new Request("https://api-app.example/rpc"))).status).toBe(503);
  expect((await app.fetch(new Request("https://api-app.example/operator/users"))).status).toBe(503);
  expect(
    (
      await app.fetch(
        new Request("https://api-app.example/management/catalog/refresh", { method: "POST" }),
      )
    ).status,
  ).toBe(503);
  await app.tick();
  expect(controls.runtime).not.toHaveBeenCalled();
  await app.close();
  expect(controls.closeStore).toHaveBeenCalledTimes(1);
});

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
  await expect(app.tick()).rejects.toThrow("scope allocation failed");
  controls.runtime.mockClear();
  controls.runtime.mockRejectedValueOnce(new Error("Mac down"));
  expect((await app.fetch(new Request("https://app/operator/users"))).status).toBe(503);
  await expect(app.tick()).rejects.toThrow("Mac down");
  expect(controls.closeStore).not.toHaveBeenCalled();
  expect((await app.fetch(new Request("https://app/management/discovery"))).status).toBe(200);
  await app.tick();
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
  const startupFailures = await Promise.allSettled([app.tick(), app.tick()]);
  expect(startupFailures).toEqual([
    { status: "rejected", reason: new Error("startup failed") },
    { status: "rejected", reason: new Error("startup failed") },
  ]);
  expect(runtime.close).toHaveBeenCalledOnce();
  expect(controls.closeStore).not.toHaveBeenCalled();
  await app.tick();
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
    await expect(app.tick()).rejects.toThrow("heartbeat dependency failed");
    await Effect.runPromise(Deferred.succeed(release, undefined));
    expect(await pending).toEqual(Exit.succeed("sent"));
    expect(runtime.close).not.toHaveBeenCalled();
    await app.tick();
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
  await app.tick();
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
