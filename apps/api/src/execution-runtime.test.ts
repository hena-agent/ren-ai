import { fromPartial } from "@total-typescript/shoehorn";
import { Context, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { beforeEach, expect, test, vi } from "vitest";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { executionBindings } from "../test/execution-bindings.ts";

const control = vi.hoisted(() => ({
  events: [] as string[],
  failure: "",
  requests: [] as string[],
  startup: async () => {},
  callback: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("callback")),
  operator: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("operator")),
}));

const step = (name: string) =>
  Effect.sync(() => {
    control.events.push(name);
    if (control.failure === name) throw new Error(`failed ${name}`);
  });

vi.mock("./personas/catalog.ts", () => ({
  catalogClient: () => ({
    load: async () => {
      control.events.push("catalog");
      if (control.failure === "catalog") throw new Error("catalog unavailable");
      return { personas: new Map() };
    },
  }),
}));
vi.mock("@ren-ai/imsg/client", () => ({
  remoteMessages: () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* client.post("https://api-msg.example/imsg/rpc/");
      return { gestures: {} };
    }),
}));
vi.mock("./execution-health.ts", () => ({
  createExecutionHealth: () => Effect.succeed({ tick: step("health") }),
}));
vi.mock("./opencode/application-gateway.ts", () => ({
  applicationGateway: () => ({
    handler: control.callback,
    dispose: async () => {
      control.events.push("callback.close");
    },
  }),
}));
vi.mock("./operator/api.ts", () => ({
  operatorHandler: () => ({
    handler: control.operator,
    dispose: async () => {
      control.events.push("operator.close");
    },
  }),
}));
vi.mock("./opencode/remote.ts", () => ({
  remoteHost: () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => step("remote.close"));
      yield* Effect.promise(() => control.startup());
      yield* step("remote");
      return { client: {} };
    }),
}));
vi.mock("./opencode/catalog-sync.ts", () => ({
  syncFolders: () => step("folders"),
  catalogRefresher: () => ({ refresh: () => step("refresh") }),
}));
vi.mock("./discovery/first-contact.ts", () => ({
  firstContacts: () => Effect.succeed({ tick: step("contacts") }),
}));
vi.mock("./application.ts", () => ({
  startMessagingApplication: (
    _personas: Map<string, never>,
    create: (tools: object) => Effect.Effect<object>,
  ) =>
    create({}).pipe(
      Effect.map(() => ({
        client: {},
        operator: {},
        conversations: {},
        heartbeat: {
          intake: step("intake"),
          followUps: step("followUps"),
          failedTurns: step("failedTurns"),
        },
      })),
    ),
}));

const open = () =>
  createExecutionRuntime(
    fromPartial<ApplicationStore>({ context: Context.empty() }),
    cloudflareConfiguration(executionBindings),
    executionBindings,
    "ground rules",
    async (input) => {
      control.requests.push(input instanceof Request ? input.url : input.toString());
      return new Response(null);
    },
  );

test("execution requires the existing management and Catalog credentials", async () => {
  for (const field of ["TOKEN_MANAGEMENT", "TOKEN_CATALOG"] as const) {
    const bindings = { ...executionBindings, [field]: undefined };
    await expect(
      createExecutionRuntime(
        fromPartial<ApplicationStore>({ context: Context.empty() }),
        cloudflareConfiguration(bindings),
        bindings,
        "rules",
        fetch,
      ),
    ).rejects.toThrow("TOKEN_MANAGEMENT and TOKEN_CATALOG are required for execution");
  }
});
beforeEach(() => {
  control.events.length = 0;
  control.requests.length = 0;
  control.failure = "";
  control.startup = async () => {};
  control.callback.mockClear();
  control.operator.mockClear();
});

test("does not start for rejected operator access; publishes callback before remote startup awaits it", async () => {
  const runtime = await open();
  try {
    expect((await runtime.fetch(new Request("https://app/operator/users"))).status).toBe(401);
    expect(control.events).toEqual([]);
    control.startup = async () => {
      const response = await runtime.fetch(new Request("https://app/rpc", { method: "POST" }));
      expect(await response.text()).toBe("callback");
    };
    expect((await runtime.fetch(new Request("https://app/rpc"))).status).toBe(503);
    await runtime.tick();
    expect(control.requests).toEqual(["https://api-msg.example/imsg/rpc"]);
    expect(control.callback).toHaveBeenCalledTimes(1);
    expect(control.events).toEqual([
      "catalog",
      "remote",
      "folders",
      "refresh",
      "intake",
      "contacts",
      "followUps",
      "failedTurns",
      "health",
    ]);
    const request = new Request("https://app/operator/users?limit=1", {
      method: "POST",
      headers: { authorization: "Bearer management-secret" },
      body: "payload",
    });
    expect(await (await runtime.fetch(request)).text()).toBe("operator");
    const forwarded = control.operator.mock.calls[0]![0];
    expect(forwarded.url).toBe("https://app/users?limit=1");
    expect(forwarded.method).toBe("POST");
    expect(await forwarded.text()).toBe("payload");
    await runtime.tick();
    expect(control.events.filter((event) => event === "catalog")).toHaveLength(1);
  } finally {
    await runtime.close();
  }
  expect(control.events.slice(-3)).toEqual(["operator.close", "remote.close", "callback.close"]);
});

test("propagates boot failure and releases partially acquired resources", async () => {
  const runtime = await open();
  control.failure = "remote";
  await expect(runtime.tick()).rejects.toThrow("failed remote");
  await runtime.close();
  expect(control.events).toEqual(["catalog", "remote", "remote.close", "callback.close"]);
});

test("observes a callback-triggered boot rejection without an unhandled promise", async () => {
  const runtime = await open();
  control.failure = "catalog";
  expect((await runtime.fetch(new Request("https://app/rpc"))).status).toBe(503);
  await expect(runtime.tick()).rejects.toMatchObject({ cause: { message: "catalog unavailable" } });
  await runtime.close();
});

test("a failed heartbeat is surfaced and the same scope can still be closed", async () => {
  const runtime = await open();
  control.failure = "health";
  await expect(runtime.tick()).rejects.toThrow("failed health");
  expect(control.events).toContain("failedTurns");
  await runtime.close();
  expect(control.events).toContain("operator.close");
});
