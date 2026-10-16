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
  expect(discoveryHandler).toHaveBeenCalledTimes(1);
  expect(managementHandler).toHaveBeenCalledTimes(1);
  await store.close();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test("closes the SQLite scope if startup assignment validation fails", async () => {
  controls.failStartup = true;
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise(() => createApplicationStore(storage, config)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  expect(dispose).not.toHaveBeenCalled();
});
