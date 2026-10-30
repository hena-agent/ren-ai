import { afterEach, expect, test, vi } from "vitest";
import { socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
import type { SocialDecision } from "@ren-ai/onboarding/social";
import { socialExecutor, socialLog } from "./server.ts";
import { socialApplication, type SocialApplication } from "./client.ts";
import { socialRunner } from "./runner.ts";
import type { SocialModel } from "./model.ts";
import { LoginRequired, type xBrowser } from "./browser.ts";
import { socialConfiguration } from "./config.ts";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const task = socialTask();
  let run = { ...task.run };
  const decisions: SocialDecision[] = [];
  const completions: string[] = [];
  const logs: Parameters<typeof socialLog>[0][] = [];
  const application: SocialApplication = {
    control: async () => ({ run, account: task.account }),
    action: async (_id, _step, decision) => {
      decisions.push(decision);
      run = {
        ...run,
        step: run.step + 1,
        contact: decision.action.kind === "contact" ? decision.action.handle : run.contact,
      };
      return { text: "result" };
    },
    complete: async (_id, state) => {
      completions.push(state);
    },
  };
  const model: SocialModel = {
    model: "test/probe",
    decide: async () => ({ action: { kind: "finish" }, reason: "Done" }),
    interrupt: async () => {},
  };
  const browser = {
    open: vi.fn<ReturnType<typeof xBrowser>["open"]>(async () => 1234),
    execute: vi.fn<ReturnType<typeof xBrowser>["execute"]>(async () => ({ text: "observed" })),
  };
  const readiness = vi.fn<Parameters<typeof socialExecutor>[0]["readiness"]>(async () => ({
    chromeCanary: true,
    agentBrowser: true,
    openCode: true,
  }));
  const handle = socialExecutor({
    token: "secret",
    application,
    model,
    browser,
    readiness,
    log: (event) => logs.push(event),
  });
  const request = (path: string, body?: object, method = body ? "POST" : "GET") =>
    handle(
      new Request(`https://social.test${path}`, {
        method,
        headers: { Authorization: "Bearer secret" },
        ...(body && { body: JSON.stringify(body) }),
      }),
    );
  const hold = () => {
    model.decide = async (_task, _run, _observation, signal) =>
      new Promise<SocialDecision>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
      });
  };
  return {
    task,
    application,
    model,
    browser,
    readiness,
    logs,
    completions,
    decisions,
    request,
    handle,
    hold,
    setRun: (next: typeof run) => {
      run = next;
    },
  };
}

test("the authenticated Mac executor acknowledges queued runs, executes scope changes and completes without blocking the request", async () => {
  const f = fixture();
  let count = 0;
  const scopes: (string | null)[] = [];
  f.model.decide = async (_task, run) => {
    scopes.push(run.contact);
    return count++ === 0
      ? { action: { kind: "contact", handle: "reader" }, reason: "Continue" }
      : { action: { kind: "finish" }, reason: "Done" };
  };
  expect((await f.request("/runs", f.task)).status).toBe(202);
  await vi.waitFor(() => expect(f.decisions).toHaveLength(2));
  expect(scopes).toEqual([null, "reader"]);
  expect((await f.request("/open", { accountId: "first" })).status).toBe(204);
  expect(f.browser.open).toHaveBeenCalledWith("first");
  expect((await f.request("/cancel", { accountId: "first" })).status).toBe(204);
});

test("headful browser actions are fenced by the current account, Persona, DM scope and active execution", async () => {
  const f = fixture();
  f.hold();
  await f.request("/runs", f.task);
  const body = { ...f.task, action: { kind: "notifications" }, id: "action-1" };
  const { snapshot: _snapshot, ...input } = body;
  expect((await f.request("/browser", input)).status).toBe(200);
  expect(f.browser.execute).toHaveBeenCalledOnce();
  for (const change of [{ generation: 2 }, { contact: "reader" }]) {
    f.setRun({ ...f.task.run, ...change });
    expect((await f.request("/browser", input)).status).toBe(503);
  }
  f.setRun(f.task.run);
  f.application.control = async () => ({
    run: f.task.run,
    account: { ...f.task.account, personaId: "bob" },
  });
  expect((await f.request("/browser", input)).status).toBe(503);
  f.application.control = async () => ({ run: f.task.run, account: f.task.account });
  expect((await f.request("/cancel", { accountId: "first" })).status).toBe(204);
  expect((await f.request("/browser", input)).status).toBe(503);
  await vi.waitFor(() => expect(f.completions).toContain("failed"));
});

test("login interruptions are reported and failure logs exclude private model and browser text", async () => {
  const f = fixture();
  f.hold();
  await f.request("/runs", f.task);
  f.browser.execute.mockRejectedValue(new LoginRequired("PRIVATE_TEXT secret"));
  const response = await f.request("/browser", {
    run: f.task.run,
    account: f.task.account,
    action: { kind: "notifications" },
    id: "action-1",
  });
  expect(response.status).toBe(503);
  expect(f.completions).toContain("login_required");
  expect(JSON.stringify(f.logs)).not.toContain("PRIVATE_TEXT");
  expect(JSON.stringify(f.logs)).not.toContain("secret");
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      requestId: response.headers.get("x-request-id"),
      stage: "request.handle",
      outcome: "failed",
    }),
  );
  await f.request("/cancel", { accountId: "first" });
});

test("unavailable completion callbacks remain observed and health reports each executor dependency", async () => {
  const f = fixture();
  f.model.decide = async () => {
    throw "PRIVATE_INPUT";
  };
  f.application.complete = async () => {
    throw new Error("private completion error");
  };
  await f.request("/runs", f.task);
  await vi.waitFor(() =>
    expect(f.logs).toContainEqual(expect.objectContaining({ code: "SOCIAL_COMPLETION_FAILED" })),
  );
  expect((await f.request("/health")).status).toBe(200);
  f.readiness.mockResolvedValue({ chromeCanary: true, agentBrowser: false, openCode: true });
  const health = await f.request("/health");
  expect(health.status).toBe(503);
  expect(await health.json()).toMatchObject({
    service: "social",
    status: "degraded",
    agentBrowser: false,
  });
  expect((await f.handle(new Request("https://social.test/health"))).status).toBe(401);
  expect((await f.request("/missing", {})).status).toBe(404);
  expect((await f.request("/runs")).status).toBe(405);
  expect((await f.request("/runs", { invalid: true })).status).toBe(503);
  expect((await f.request("/runs", { text: "x".repeat(140001) })).status).toBe(503);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  socialLog({
    requestId: "test",
    operation: "test",
    stage: "test",
    outcome: "completed",
    durationMs: 0,
    level: "info",
  });
  socialLog({
    requestId: "test",
    operation: "test",
    stage: "test",
    outcome: "failed",
    durationMs: 0,
    level: "error",
  });
});

test("an account admits one runner, cancels model work and stops after a deadline", async () => {
  const f = fixture();
  f.hold();
  const runner = socialRunner(f.application, f.model);
  const first = runner.start(f.task);
  expect(runner.start(f.task)).toBeUndefined();
  expect(() => runner.start({ ...f.task, run: { ...f.task.run, id: "other" } })).toThrow(
    "already running",
  );
  await runner.cancel("first", "older-run");
  expect(() => runner.active("first", "wrong-run")).toThrow("not active");
  const cancellation = runner.cancel("first", f.task.run.id);
  expect(() => runner.active("first", f.task.run.id)).toThrow("not active");
  await cancellation;
  await expect(first).rejects.toThrow(Error);
  expect(() => runner.active("first", "run-1")).toThrow("not active");
  await runner.cancel("missing");
  const timeout = fixture();
  timeout.application.control = async () => {
    throw new Error("stopped");
  };
  await expect(
    socialRunner(timeout.application, timeout.model).start(timeout.task),
  ).rejects.toThrow("stopped");
});

test("run deadlines stop additional model judgments even if a browser result arrives late", async () => {
  const f = fixture();
  let turns = 0;
  f.model.decide = async () => {
    turns++;
    return { action: { kind: "notifications" }, reason: "Read" };
  };
  f.application.control = async () => ({
    run: f.task.run,
    account: f.task.account,
    history: "recorded actions",
  });
  f.application.action = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { text: "observed" };
  };
  await socialRunner(f.application, f.model).start({
    ...f.task,
    run: { ...f.task.run, deadline: Date.now() + 50 },
  });
  expect(turns).toBe(1);
});

test("default diagnostics retain safe root causes and correlation while excluding payload-bearing errors", async () => {
  const f = fixture();
  const output: string[] = [];
  for (const stream of [process.stdout, process.stderr])
    vi.spyOn(stream, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
  const handle = socialExecutor({
    token: "secret",
    application: f.application,
    model: f.model,
    browser: f.browser,
    readiness: f.readiness,
  });
  const root = Object.assign(new Error("PRIVATE_ROOT"), {
    code: "SAFE_UPSTREAM",
    upstreamStatus: 429,
  });
  const badCode = Object.assign(new Error("PRIVATE_ROOT"), {
    code: "PRIVATE echoed prompt",
    upstreamStatus: "PRIVATE",
  });
  delete badCode.stack;
  const numeric = Object.assign(new Error("PRIVATE_ROOT"), { code: 123 });
  const parent = "00000000-0000-4000-8000-000000000001";
  for (const error of [
    new Error("PRIVATE_WRAPPER", { cause: root }),
    badCode,
    numeric,
    "PRIVATE_NON_ERROR",
  ]) {
    f.readiness.mockRejectedValue(error);
    const response = await handle(
      new Request("https://social.test/health", {
        headers: { Authorization: "Bearer secret", "X-Operation-ID": parent },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(output.join("")).toContain("SAFE_UPSTREAM");
  expect(output.join("")).toContain(parent);
  expect(output.join("")).not.toContain("PRIVATE");
  expect(
    (
      await handle(
        new Request("https://social.test/health", { headers: { "X-Operation-ID": "invalid" } }),
      )
    ).status,
  ).toBe(401);
});

test("duplicate dispatches observe one execution and browser failures preserve their stage", async () => {
  const f = fixture();
  f.hold();
  await f.request("/runs", f.task);
  await f.request("/runs", f.task);
  expect(
    f.logs.filter((event) => event.operation === "social.run" && event.outcome === "started"),
  ).toHaveLength(1);
  f.browser.execute.mockRejectedValue(new Error("browser disconnected"));
  expect(
    (
      await f.request("/browser", {
        run: f.task.run,
        account: f.task.account,
        action: { kind: "notifications" },
        id: "action-1",
      })
    ).status,
  ).toBe(503);
  await f.request("/cancel", { accountId: "first", runId: "old-run" });
  await f.request("/cancel", { accountId: "first", runId: f.task.run.id });
  const login = fixture();
  login.model.decide = async () => {
    throw new LoginRequired("challenge");
  };
  await login.request("/runs", login.task);
  await vi.waitFor(() => expect(login.completions).toContain("login_required"));
});

test("the native application client validates responses and never follows credential-bearing redirects", async () => {
  const task = socialTask();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(new Request(input).url).pathname;
    if (path.endsWith("complete")) return new Response(null, { status: 204 });
    if (path.endsWith("actions")) return Response.json({ text: "result" });
    return Response.json({ run: task.run, account: task.account });
  });
  const client = socialApplication("https://app.test", "secret", fetcher);
  expect(await client.control(task.run.id)).toEqual({ run: task.run, account: task.account });
  await client.control(task.run.id, true);
  expect(
    await client.action(task.run.id, 0, { action: { kind: "finish" }, reason: "Done" }),
  ).toEqual({ text: "result" });
  await client.complete(task.run.id, "completed");
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
    "Bearer secret",
  );
  fetcher.mockResolvedValue(new Response(null, { status: 302 }));
  await expect(client.control(task.run.id)).rejects.toMatchObject({
    code: "SOCIAL_APPLICATION_REQUEST",
    upstreamStatus: 302,
  });
});

test("Mac configuration requires protected credentials, absolute profile storage and a valid port", () => {
  const env = {
    TOKEN_MANAGEMENT: "secret",
    APPLICATION_API_URL: "https://api.test",
    OPENCODE_URL: "https://oc.test",
    OPENCODE_AUTHORIZATION: "Basic test",
    SOCIAL_HOME: "/tmp/social",
  };
  expect(socialConfiguration(env)).toMatchObject({ port: 5407, home: "/tmp/social" });
  expect(
    socialConfiguration({
      ...env,
      SOCIAL_PORT: "0",
      SOCIAL_CHROME: "canary",
      SOCIAL_AGENT_BROWSER: "browser",
      PERSONA_MODEL: "test/model",
      OPENCODE_DIRECTORY: "/personas",
    }),
  ).toMatchObject({
    port: 0,
    chrome: "canary",
    browser: "browser",
    opencode: { model: "test/model", directory: "/personas" },
  });
  for (const change of [
    { TOKEN_MANAGEMENT: "" },
    { SOCIAL_HOME: "relative" },
    { SOCIAL_PORT: "65536" },
    { OPENCODE_URL: "https://user:secret@oc.test" },
    { APPLICATION_API_URL: "http://remote.test" },
  ])
    expect(() => socialConfiguration({ ...env, ...change })).toThrow(Error);
  expect(
    socialConfiguration({
      ...env,
      APPLICATION_API_URL: "http://localhost:4879",
      OPENCODE_URL: "http://127.0.0.1:4096",
    }).port,
  ).toBe(5407);
});
