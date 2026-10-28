import { control } from "../test/execution-runtime.test-helper.ts";
import { fromPartial } from "@total-typescript/shoehorn";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/sql";
import { migrate } from "./database.ts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplicationStore } from "./application-store.ts";
import { cloudflareConfiguration, type CloudflareBindings } from "./cloudflare-config.ts";
import { createExecutionRuntime } from "./execution-runtime.ts";
import { executionBindings } from "../test/execution-bindings.ts";
import type { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import { Session } from "@opencode/schema/session";

let scope: Scope.Closeable;
let database: Context.Context<SqlClient.SqlClient>;
const execSql = (query: string) =>
  Effect.runPromise(Context.get(database, SqlClient.SqlClient).unsafe(query));

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
  await execSql("UPDATE application_work SET due = 0 WHERE name = 'turn:ses_due'");
  await execSql(
    "INSERT INTO failed_turn(session_id, fingerprint, failures, quota, failed_at, retry_at) VALUES ('ses_due', 'checkpoint', 1, 0, 0, 0)",
  );
  await execSql("DELETE FROM application_clock WHERE name = 'recovery'");
  await execSql("DELETE FROM application_clock WHERE name = 'catalog.recovery'");
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
  await execSql("UPDATE application_work SET due = 0 WHERE name = 'lane:execution.cursor:catalog'");
  await runtime.tick();
  expect(control.events.filter((entry) => entry === "reconcile")).toHaveLength(2);
  await runtime.close();
  await execSql("UPDATE runtime_catalog SET payload = 'private-invalid-cache'");
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

const open = (bindings: CloudflareBindings = executionBindings) =>
  createExecutionRuntime(
    fromPartial<ApplicationStore>({
      context: database,
      maintainCatalog: Effect.sync(() => {
        control.events.push("publicCatalog");
      }),
    }),
    cloudflareConfiguration(bindings),
    bindings,
    "ground rules",
    async (input) => {
      control.requests.push(input instanceof Request ? input.url : input.toString());
      return new Response(null);
    },
  );

test("the production photo binding drains persisted private-object cleanup after actor replacement", async () => {
  const deleted: string[] = [];
  const bindings: CloudflareBindings = {
    ...executionBindings,
    CONVERSATION_PHOTOS: fromPartial({
      delete: async (key: string) => {
        deleted.push(key);
      },
    }),
  };
  await execSql("INSERT INTO photo_object VALUES ('expired', 0)");
  let runtime = await open(bindings);
  await runtime.tick();
  await runtime.close();
  expect(deleted).toHaveLength(1);
  await execSql("INSERT INTO photo_object VALUES ('removed', 0)");
  runtime = await open({ ...bindings, CODEX_IMAGE_API_KEY: "private-key" });
  await runtime.tick();
  await runtime.close();
  expect(deleted).toHaveLength(2);
  expect(await execSql("SELECT * FROM photo_object")).toEqual([]);
});

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

test.each(["messages?id=999", "message-image?id=999&message=1&guid=private&attachment=0"])(
  "operator %s authenticates and reads without booting a persona",
  async (path) => {
    const runtime = await open();
    const url = `https://app/operator/${path}`;
    try {
      expect((await runtime.fetch(new Request(url))).status).toBe(401);
      const response = await runtime.fetch(
        new Request(url, { headers: { authorization: "Bearer management-secret" } }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(control.events).toEqual([]);
    } finally {
      await runtime.close();
    }
  },
);

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
      "publicCatalog",
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
    await execSql("INSERT INTO application_clock (name, at) VALUES ('catalog.public', 1)");
    expect((await notify()).status).toBe(204);
    expect(control.events).toEqual(["catalog", "remote", "folders", "refresh"]);
    // The served public snapshot is fenced and reloaded by the next alarm, not by a visitor.
    expect(await execSql("SELECT payload, generation FROM public_catalog")).toEqual([
      { payload: null, generation: 1 },
    ]);
    expect(await execSql("SELECT * FROM application_clock WHERE name = 'catalog.public'")).toEqual(
      [],
    );
    expect(await execSql("SELECT name FROM application_work WHERE name = 'maintenance'")).toEqual([
      { name: "maintenance" },
    ]);
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
  // Discovery's public snapshot maintenance does not depend on execution starting.
  expect(control.events).toEqual([
    "catalog",
    "remote",
    "remote.close",
    "callback.close",
    "publicCatalog",
  ]);
  const retrying = await open();
  control.failure = "";
  control.startup = () => Promise.reject("private non-error startup failure");
  await execSql("UPDATE application_work SET due = 0 WHERE name GLOB 'lane:*'");
  await expect(retrying.tick()).rejects.toThrow("Execution startup unavailable");
  control.startup = async () => {};
  await execSql("UPDATE application_work SET due = 0 WHERE name GLOB 'lane:*'");
  await retrying.tick();
  expect(retrying.initialized).toBe(true);
  await retrying.close();
});

test("observes a callback-triggered boot rejection without an unhandled promise", async () => {
  const runtime = await open();
  control.failure = "catalog";
  expect((await runtime.fetch(new Request("https://app/rpc"))).status).toBe(503);
  await expect(runtime.tick()).rejects.toMatchObject({
    cause: { cause: { message: "catalog unavailable" } },
  });
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
  await execSql("UPDATE application_work SET due = 0 WHERE name = 'lane:execution.cursor:endings'");
  await runtime.tick();
  expect(control.events.filter((event) => event === "endings")).toHaveLength(2);
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
