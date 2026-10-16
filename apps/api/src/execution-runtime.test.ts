import { fromPartial } from "@total-typescript/shoehorn";
import { Context, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { beforeEach, expect, test, vi } from "vitest";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import type { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";

const control = vi.hoisted(() => ({
  events: [] as string[],
  failure: "",
  requests: [] as string[],
  startup: async () => {},
  callback: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("callback")),
  operator: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("operator")),
  folderRead: vi.fn<() => Effect.Effect<typeof folderSnapshot.Type, Error>>(),
  languageFailure: undefined as Error | undefined,
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
vi.mock("./discovery/conversation-languages.ts", () => ({
  conversationLanguages:
    (read: (id: string) => Effect.Effect<typeof folderSnapshot.Type, Error>) => () =>
      read("ses_languages").pipe(
        Effect.match({
          onSuccess: () => new Response("languages"),
          onFailure: (cause) => {
            control.languageFailure = cause;
            return new Response("unavailable", { status: 503 });
          },
        }),
      ),
}));
vi.mock("./application.ts", () => ({
  startMessagingApplication: (
    _personas: Map<string, never>,
    create: (tools: object) => Effect.Effect<object>,
  ) =>
    create({}).pipe(
      Effect.map(() => ({
        client: { rpc: () => ({ read: control.folderRead }) },
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
  control.folderRead.mockReset();
  control.languageFailure = undefined;
});

test("authenticated language reads use the configured executor location and preserve upstream failure causes", async () => {
  const runtime = await open();
  const request = new Request("https://app/operator/languages", {
    headers: { authorization: "Bearer management-secret" },
  });
  try {
    control.folderRead.mockReturnValueOnce(
      Effect.succeed(fromPartial<typeof folderSnapshot.Type>({})),
    );
    expect(await (await runtime.fetch(request.clone())).text()).toBe("languages");
    expect(control.folderRead).toHaveBeenCalledWith(
      { folderID: "ses_languages" },
      { location: { directory: cloudflareConfiguration(executionBindings).execution.directory } },
    );
    expect(control.operator).not.toHaveBeenCalled();
    const cause = Object.assign(new Error("private upstream payload"), { code: "ECONNRESET" });
    control.folderRead.mockReturnValueOnce(Effect.fail(cause));
    expect((await runtime.fetch(request.clone())).status).toBe(503);
    expect(control.languageFailure).toMatchObject({
      message: "Conversation State could not be read",
      cause,
    });
  } finally {
    await runtime.close();
  }
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
    expect(control.events).not.toContain("refresh");
  } finally {
    await runtime.close();
  }
  expect(control.events.slice(-3)).toEqual(["operator.close", "remote.close", "callback.close"]);
});

test("only authenticated POST notifications refresh the Catalog, without running a heartbeat", async () => {
  const runtime = await open();
  const notify = (method = "POST", token = "management-secret") =>
    runtime.fetch(
      new Request("https://app/management/catalog/refresh", {
        method,
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  try {
    expect((await notify("POST", "wrong")).status).toBe(401);
    expect(control.events).toEqual([]);
    expect((await notify("GET")).status).toBe(405);
    expect(control.events).toEqual([]);
    expect((await notify()).status).toBe(204);
    expect(control.events).toEqual(["catalog", "remote", "folders", "refresh"]);
    expect((await notify()).status).toBe(204);
    expect(control.events.filter((event) => event === "refresh")).toHaveLength(2);
    expect(control.operator).not.toHaveBeenCalled();
    control.failure = "refresh";
    const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const failure = await notify();
      expect(failure.status).toBe(503);
      const requestId = failure.headers.get("x-request-id");
      expect(await failure.json()).toMatchObject({ error: "Catalog refresh failed", requestId });
      const events = diagnostic.mock.calls.map(([line]) => String(line)).join("");
      expect(events).toContain(requestId);
      expect(events).toContain('"operation":"catalog.refresh"');
      expect(events).toContain('"stage":"catalog.sync"');
      expect(events).toContain('"causeName":"Error"');
      expect(events).not.toContain("failed refresh");
      expect(events).not.toContain("management-secret");
    } finally {
      diagnostic.mockRestore();
    }
  } finally {
    await runtime.close();
  }
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
