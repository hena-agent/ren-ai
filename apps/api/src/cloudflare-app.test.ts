import { fromPartial } from "@total-typescript/shoehorn";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { afterEach, expect, test, vi } from "vitest";
import { createCloudflareApplication } from "./cloudflare-app.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";

const controls = vi.hoisted(() => ({
  failStore: false,
  storeHandler: vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("registry"),
  ),
  closeStore: vi.fn<() => Promise<void>>(async () => undefined),
}));

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
  TOKEN_EXECUTOR: "executor-token",
  REN_AI_APPLICATION_TOKEN: "application-token",
};
const fetcher: typeof fetch = async () => Response.json({ success: true });

afterEach(() => {
  controls.failStore = false;
  controls.storeHandler.mockClear();
  controls.closeStore.mockClear();
});

test("serves safe health, holds registry writes in bootstrap and closes its scopes", async () => {
  const app = await createCloudflareApplication(storage, bindings, "rules", fetcher);
  expect(app.store).toBeDefined();
  expect(app.configuration.bootstrapOnly).toBe(true);
  const health = await app.fetch(new Request("https://api-app.example/health"));
  expect(await health.json()).toEqual({
    database: "ready",
    storage: "durable-object-sqlite",
    bootstrapOnly: true,
  });
  expect(health.headers.get("cache-control")).toBe("no-store");
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
  await app.close();
  expect(controls.closeStore).toHaveBeenCalledTimes(1);
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
