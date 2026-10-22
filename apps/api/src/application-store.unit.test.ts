import { fromPartial } from "@total-typescript/shoehorn";
import { Effect, Exit } from "effect";
import { HttpClient } from "effect/unstable/http";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { afterEach, expect, test, vi } from "vitest";
import { createApplicationStore } from "./application-store.ts";

const controls = vi.hoisted(() => ({ failStartup: false }));
const discoveryHandler = vi.fn<(request: Request) => Promise<Response>>(
  async () => new Response("discovery"),
);
const dispose = vi.fn<() => Promise<void>>(async () => undefined);
const managementHandler = vi.fn<(request: Request) => Promise<Response>>(
  async () => new Response("management"),
);

vi.mock("./database.ts", () => ({ migrate: Effect.void }));
vi.mock("./discovery/assignment.ts", () => ({
  get checkAssignments() {
    return controls.failStartup ? Effect.fail(new Error("assignment conflict")) : Effect.void;
  },
}));
vi.mock("./discovery/contacts.ts", () => ({
  contacts: () =>
    Effect.succeed({
      list: Effect.void,
      select: vi.fn<(input: object, requestId: string) => void>(),
      start: vi.fn<(input: object, requestId: string) => void>(),
    }),
}));
vi.mock("./discovery/management.ts", () => ({
  contactManagement: () => managementHandler,
}));
vi.mock("./discovery/discovery.ts", () => ({
  makeDiscoveryWeb: () => Effect.succeed({ handler: discoveryHandler, dispose }),
}));
vi.mock("./conversations/status.ts", () => ({
  conversationStatus: () =>
    Effect.succeed({
      list: () => Effect.succeed({ entries: [], nextBefore: null }),
      detail: () => Effect.succeed(undefined),
    }),
}));

const storage = fromPartial<DurableObjectStorage>({
  sql: { exec: vi.fn<() => never>() },
});
const config = {
  catalog: async () => [],
  turnstileSecret: "test-secret",
  managementToken: "test-token",
  httpClient: fromPartial<HttpClient.HttpClient>({}),
};

afterEach(() => {
  controls.failStartup = false;
  discoveryHandler.mockClear();
  dispose.mockClear();
  managementHandler.mockClear();
});

test("retains the SQL context for effects, routes registry requests and closes scoped resources", async () => {
  const store = await createApplicationStore(storage, config);
  expect(await store.run(Effect.succeed("same client"))).toBe("same client");
  expect(
    await (await store.handler(new Request("https://api.test/discovery/personas"))).text(),
  ).toBe("discovery");
  expect(
    await (await store.handler(new Request("https://api.test/management/discovery"))).text(),
  ).toBe("management");
  expect((await store.handler(new Request("https://api.test/not-found"))).status).toBe(404);
  const records = await store.handler(
    new Request("https://api.test/management/conversations", {
      headers: { Authorization: "Bearer test-token" },
    }),
  );
  expect(records.status).toBe(200);
  expect(
    (
      await store.handler(
        new Request("https://api.test/management/conversations/1/end", {
          method: "POST",
          headers: { Authorization: "Bearer test-token" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(400);
  expect(await records.json()).toEqual({ entries: [], nextBefore: null });
  expect(
    (await store.handler(new Request("https://api.test/management/conversations"))).status,
  ).toBe(401);
  expect(discoveryHandler).toHaveBeenCalledTimes(1);
  expect(managementHandler).toHaveBeenCalledTimes(1);
  await store.close();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("conversation records fail closed when the application's management token is unconfigured", async () => {
  const store = await createApplicationStore(storage, { ...config, managementToken: "" });
  try {
    const response = await store.handler(new Request("https://api.test/management/conversations"));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
  } finally {
    await store.close();
  }
});

test("closes the SQLite scope if startup assignment validation fails", async () => {
  controls.failStartup = true;
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise(() => createApplicationStore(storage, config)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(dispose).not.toHaveBeenCalled();
});
