import { fromPartial } from "@total-typescript/shoehorn";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { afterEach, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import { createCloudflareApplication } from "./cloudflare-app.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";
import { executionBindings, readyApplicationHealth } from "../test/execution-bindings.ts";

type RuntimeDouble = {
  fetch: Mock<(request: Request) => Promise<Response>>;
  tick: Mock<() => Promise<void>>;
  close: Mock<() => Promise<void>>;
};

const controls = vi.hoisted(() => ({
  failStore: false,
  storeHandler: vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("registry"),
  ),
  closeStore: vi.fn<() => Promise<void>>(async () => undefined),
  runtime: vi.fn<() => Promise<RuntimeDouble>>(async () => ({
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
const fetcher: typeof fetch = async () =>
  Response.json({ service: "api-msg", revision: "development", status: "ready" });
const settledRuntime = () => {
  const result = controls.runtime.mock.settledResults.at(-1);
  if (result?.type !== "fulfilled") throw new Error("Execution did not open");
  return result.value;
};

afterEach(() => {
  controls.failStore = false;
  controls.storeHandler.mockClear();
  controls.closeStore.mockClear();
  controls.runtime.mockClear();
});

test("serves safe health, holds registry writes in bootstrap and closes its scopes", async () => {
  const app = await createCloudflareApplication(storage, bindings, "rules", fetcher);
  expect(app.store).toBeDefined();
  expect(app.configuration.bootstrapOnly).toBe(true);
  const health = await app.fetch(new Request("https://api-app.example/health"));
  expect(await health.json()).toEqual(readyApplicationHealth);
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
    await (await app.fetch(new Request("https://api-app.example/discovery/personas"))).text(),
  ).toBe("registry");
  expect(
    await (
      await app.fetch(new Request("https://api-app.example/discovery/personas", { method: "HEAD" }))
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

test("registry remains usable with execution down; the next alarm retries execution, not SQLite", async () => {
  const app = await createCloudflareApplication(storage, executionBindings, "rules", fetcher);
  expect((await app.fetch(new Request("https://app/discovery/personas"))).status).toBe(200);
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
  runtime.tick.mockRejectedValueOnce(new Error("tick failed"));
  runtime.close.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(app.tick()).rejects.toThrow("tick failed");
  expect(runtime.close).toHaveBeenCalledOnce();
  expect(controls.closeStore).not.toHaveBeenCalled();
  await app.tick();
  await app.close();
  expect(controls.closeStore).toHaveBeenCalledOnce();
});

test("a live database cannot conceal an executor URL serving the wrong application", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const app = await createCloudflareApplication(storage, bindings, "rules", async () =>
    Response.json({
      service: "old-app",
      revision: "development",
      status: "ready",
      private: "private-marker",
    }),
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
      executor: { status: "unexpected_response" },
    });
    expect(JSON.stringify(stderr.mock.calls)).toContain(response.headers.get("x-request-id"));
    expect(JSON.stringify(stderr.mock.calls)).toContain("executor_unexpected_response");
    expect(
      (await app.fetch(new Request("https://api-app.example/discovery/personas"))).status,
    ).toBe(200);
    expect(controls.runtime).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    await app.close();
  }
});

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
