import { fromPartial } from "@total-typescript/shoehorn";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
import { migrate } from "./database.ts";
import { HttpClient } from "effect/unstable/http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import type { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import { Session } from "@opencode/schema/session";
import type { RemoteConfig } from "./opencode/remote.ts";
import type {
  SessionActiveOutput,
  MessageListInput,
  MessageListOutput,
} from "@opencode/client/effect/api";

const control = vi.hoisted(() => ({
  events: [] as string[],
  failure: "",
  requests: [] as string[],
  startup: async () => {},
  callback: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("callback")),
  operator: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("operator")),
  folderRead: vi.fn<() => Effect.Effect<typeof folderSnapshot.Type, Error>>(),
  languageFailure: undefined as Error | undefined,
  activeRead: vi.fn<() => Effect.Effect<SessionActiveOutput, Error>>(),
  activeProbe: vi.fn<(id: Session.ID) => Effect.Effect<boolean, Error>>(),
  onPrompt: vi.fn<(id: string) => Effect.Effect<void, Error>>(),
  usageApi: undefined as
    | {
        messages: (input: MessageListInput) => Effect.Effect<MessageListOutput, Error>;
        get: (id: Session.ID) => Effect.Effect<Session.Info, Error>;
      }
    | undefined,
  removeSession: undefined as ((id: Session.ID) => Effect.Effect<void, Error>) | undefined,
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
      return {
        revision: String(control.events.filter((event) => event === "catalog").length),
        personas: new Map(),
      };
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
vi.mock("./usage/collect.ts", () => ({
  usageCollector: (api: typeof control.usageApi) =>
    Effect.sync(() => {
      control.usageApi = api;
      return { tick: Effect.void, session: () => step("usage.snapshot") };
    }),
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
  remoteHost: (config: RemoteConfig) =>
    Effect.gen(function* () {
      control.onPrompt.mockImplementation(config.onPrompt!);
      yield* Effect.addFinalizer(() => step("remote.close"));
      yield* Effect.promise(() => control.startup());
      yield* step("remote");
      return {
        client: {
          session: { active: control.activeRead },
          message: { list: () => Effect.fail(new Error("upstream usage failed")) },
        },
        sessions: {
          get: () => Effect.succeed(fromPartial<Session.Info>({ id: "ses_usage" })),
          remove: () => step("session.remove"),
        },
      };
    }),
}));
vi.mock("./opencode/catalog-sync.ts", () => ({
  syncFolders: () => step("folders"),
  catalogRefresher: () => ({ refresh: () => step("refresh"), reconcile: () => step("reconcile") }),
}));
vi.mock("./discovery/first-contact.ts", () => ({
  firstContacts: () => Effect.succeed({ tick: step("contacts") }),
}));
vi.mock("./conversations/runtime-status.ts", () => ({
  runtimeStatus: (_host: object, active: (id: Session.ID) => Effect.Effect<boolean, Error>) =>
    Effect.sync(() => {
      control.activeProbe.mockImplementation(active);
      return {};
    }),
  runtimeStatusRequest:
    (_service: object, run: (effect: Effect.Effect<void>) => Promise<void>) => async () => {
      await run(Effect.void);
      return new Response("conversation-status");
    },
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
    create: (
      tools: object,
    ) => Effect.Effect<{ sessions: { remove: (id: Session.ID) => Effect.Effect<void, Error> } }>,
  ) =>
    create({}).pipe(
      Effect.tap((host) =>
        Effect.sync(() => {
          control.removeSession = host.sessions.remove;
        }),
      ),
      Effect.map(() => ({
        client: {
          rpc: () => ({ read: control.folderRead }),
          session: { active: control.activeRead },
        },
        operator: {},
        conversations: {},
        heartbeat: {
          endings: step("endings"),
          stopped: step("stopped"),
          intake: step("intake"),
          followUps: step("followUps"),
          failedTurns: step("failedTurns"),
          checkTurns: () => step("checkTurns"),
          rebuilds: step("rebuilds"),
        },
      })),
    ),
}));
vi.mock("./application-tools.ts", () => ({
  prepareMessaging: () => Effect.succeed({ endings: {} }),
}));

let scope: Scope.Closeable;
let database: Context.Context<SqlClient.SqlClient>;
beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  database = await Effect.runPromise(
    Layer.buildWithScope(SqliteClient.layer({ filename: ":memory:" }), scope),
  );
  await Effect.runPromise(migrate.pipe(Effect.provideContext(database)));
});

test("actor replacement reuses its applied Catalog and fails safely on a corrupt private cache", async () => {
  let runtime = await open();
  await runtime.tick();
  await Effect.runPromise(control.onPrompt("ses_due"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE application_work SET due = 0 WHERE name = 'turn:ses_due'`;
      yield* sql`DELETE FROM application_clock WHERE name = 'recovery'`;
    }).pipe(Effect.provideContext(database)),
  );
  await runtime.close();
  control.events.length = 0;
  runtime = await open();
  control.failure = "reconcile";
  await expect(runtime.tick()).rejects.toThrow("failed reconcile");
  expect(control.events).not.toContain("catalog");
  expect(control.events).not.toContain("folders");
  expect(control.events).toContain("checkTurns");
  expect(control.events).toContain("failedTurns");
  expect(control.events).toContain("stopped");
  await runtime.tick();
  expect(control.events.filter((entry) => entry === "reconcile")).toHaveLength(1);
  control.failure = "";
  await runtime.close();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE runtime_catalog SET payload = 'private-invalid-cache'`;
    }).pipe(Effect.provideContext(database)),
  );
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  runtime = await open();
  try {
    await expect(runtime.tick()).rejects.toThrow("Invalid persisted Catalog");
    const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logged).not.toContain("private-invalid-cache");
    expect(logged).toContain("CATALOG_CACHE_INVALID");
  } finally {
    await runtime.close();
    stderr.mockRestore();
  }
});
afterEach(() => Effect.runPromise(Scope.close(scope, Exit.void)));

const open = () =>
  createExecutionRuntime(
    fromPartial<ApplicationStore>({ context: database }),
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
  control.activeRead.mockReset().mockReturnValue(Effect.succeed({}));
  control.activeProbe.mockReset();
});

test("operator conversation status authenticates before boot and reads actual executor activity without prompting", async () => {
  const runtime = await open();
  try {
    const url = "https://app/operator/conversations?id=1";
    expect((await runtime.fetch(new Request(url))).status).toBe(401);
    expect(control.events).toEqual([]);
    const response = await runtime.fetch(
      new Request(url, { headers: { authorization: "Bearer management-secret" } }),
    );
    expect(await response.text()).toBe("conversation-status");
    expect(control.events).not.toContain("catalog");
    expect(control.events).not.toContain("folders");
    expect(control.events).not.toContain("intake");
    const id = Session.ID.make("ses_status");
    control.activeRead.mockReturnValueOnce(Effect.succeed({ [id]: { type: "running" } }));
    expect(await Effect.runPromise(control.activeProbe(id))).toBe(true);
    expect(await Effect.runPromise(control.activeProbe(id))).toBe(false);
    const cause = new Error("executor failed");
    control.activeRead.mockReturnValueOnce(Effect.fail(cause));
    const failure = await Effect.runPromise(control.activeProbe(id).pipe(Effect.flip));
    expect(failure.cause).toBe(cause);
    expect(
      await (
        await runtime.fetch(
          new Request(url, { headers: { authorization: "Bearer management-secret" } }),
        )
      ).text(),
    ).toBe("conversation-status");
  } finally {
    await runtime.close();
  }
});

const operatorConversationRequest = () =>
  new Request("https://app/operator/conversations?id=1", {
    headers: { authorization: "Bearer management-secret" },
  });

test("a failed metadata inspector can be retried without starting a messaging application", async () => {
  const runtime = await open();
  try {
    control.failure = "remote";
    await expect(runtime.fetch(operatorConversationRequest())).rejects.toThrow("failed remote");
    control.failure = "";
    expect((await runtime.fetch(operatorConversationRequest())).status).toBe(200);
    expect(control.events).not.toContain("intake");
  } finally {
    await runtime.close();
  }
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
      expect(runtime.initialized).toBe(false);
      const response = await runtime.fetch(new Request("https://app/rpc", { method: "POST" }));
      expect(await response.text()).toBe("callback");
    };
    expect((await runtime.fetch(new Request("https://app/rpc"))).status).toBe(503);
    await runtime.tick();
    expect(runtime.initialized).toBe(true);
    expect(control.requests).toEqual(["https://api-msg.example/imsg/rpc/"]);
    expect(control.callback).toHaveBeenCalledTimes(1);
    expect(control.events).toEqual([
      "catalog",
      "health",
      "remote",
      "folders",
      "intake",
      "contacts",
      "followUps",
      "failedTurns",
      "rebuilds",
      "stopped",
      "endings",
      "reconcile",
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
  expect(runtime.initialized).toBe(false);
  await runtime.close();
  expect(control.events).toEqual(["health", "catalog", "remote", "remote.close", "callback.close"]);
});

test("observes a callback-triggered boot rejection without an unhandled promise", async () => {
  const runtime = await open();
  control.failure = "catalog";
  expect((await runtime.fetch(new Request("https://app/rpc"))).status).toBe(503);
  await expect(runtime.tick()).rejects.toMatchObject({ cause: { message: "catalog unavailable" } });
  await runtime.close();
});

test("a failed first heartbeat retains successful initialization and retries without booting again", async () => {
  const runtime = await open();
  expect(runtime.initialized).toBe(false);
  control.failure = "endings";
  await expect(runtime.tick()).rejects.toThrow("failed endings");
  expect(runtime.initialized).toBe(true);
  expect(control.events).toContain("failedTurns");
  control.failure = "";
  await runtime.tick();
  expect(control.events.filter((event) => event === "catalog")).toHaveLength(1);
  expect(control.events).not.toContain("callback.close");
  await runtime.close();
  expect(control.events).toContain("operator.close");
});

test("executor accounting preserves upstream causes and requires a final snapshot before session removal", async () => {
  const runtime = await open();
  try {
    await runtime.tick();
    const id = Session.ID.make("ses_usage");
    expect((await Effect.runPromise(control.usageApi!.get(id))).id).toBe(id);
    const failure = await Effect.runPromise(
      control.usageApi!.messages({ sessionID: id }).pipe(Effect.flip),
    );
    expect(failure.message).toBe("OpenCode usage history unavailable");
    expect(failure.cause).toHaveProperty("message", "upstream usage failed");
    const offset = control.events.length;
    await Effect.runPromise(control.removeSession!(id));
    expect(control.events.slice(offset)).toEqual(["usage.snapshot", "session.remove"]);
    control.failure = "usage.snapshot";
    const before = control.events.length;
    await expect(Effect.runPromise(control.removeSession!(id))).rejects.toThrow(
      "failed usage.snapshot",
    );
    expect(control.events.slice(before)).toEqual(["usage.snapshot"]);
  } finally {
    await runtime.close();
  }
});
