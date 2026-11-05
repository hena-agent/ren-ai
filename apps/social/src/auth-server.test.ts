import { expect, test, vi } from "vitest";
import { authFixture, privateLogin } from "../test/auth.test-helper.ts";
import { socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
import { socialExecutor } from "./server.ts";
import type { socialLog } from "./logging.ts";
import { applicationFixture } from "../test/application.test-helper.ts";
import type { SocialModel } from "./model.ts";
import { AuthenticationError } from "./auth-store.ts";

function fixture() {
  const f = authFixture();
  const task = socialTask();
  const logs: Parameters<typeof socialLog>[0][] = [];
  const application = applicationFixture(task);
  const model: SocialModel = {
    model: "test/auth",
    decide: (_task, _run, _observation, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
      }),
    interrupt: async () => {},
  };
  const browser = {
    open: async () => 1234,
    execute: async () => {
      throw new AuthenticationError({ state: "code_required", hasCredentials: true });
    },
  };
  const handle = socialExecutor({
    token: "auth-token",
    authentication: f.auth,
    application,
    model,
    browser,
    readiness: async () => ({ chromeCanary: true, agentBrowser: true, openCode: true }),
    log: (event) => {
      logs.push(event);
    },
  });
  const request = (path: string, body: object) =>
    handle(
      new Request(`https://executor.test${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer auth-token" },
        body: JSON.stringify(body),
      }),
    );
  return { ...f, task, logs, handle, request };
}

test("native login requests acknowledge promptly, expose only status and diagnose expected conflicts without credentials", async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.commands.open = async () => {
    await pending;
    return 1234;
  };
  const response = await f.request("/auth", {
    account: f.account,
    command: { kind: "save", username: privateLogin.username, password: privateLogin.password },
  });
  expect(response.status).toBe(202);
  const body = await response.text();
  expect(body).not.toContain(privateLogin.password);
  expect(body).not.toContain(privateLogin.username);
  const busy = await f.request("/auth", { account: f.account, command: { kind: "login" } });
  expect(busy.status).toBe(409);
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      requestId: busy.headers.get("x-request-id"),
      level: "warn",
      code: "SOCIAL_AUTH_CONFLICT",
    }),
  );
  release();
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
  const status = await f.request("/auth", { account: f.account, command: { kind: "status" } });
  expect(await status.json()).toEqual({ state: "authenticated", hasCredentials: true });
  expect(JSON.stringify(f.logs)).not.toContain(privateLogin.password);
  expect(JSON.stringify(f.logs)).not.toContain(privateLogin.username);
});

test("a pre-submit authentication interruption uses a typed blocked response rather than an uncertain-send success", async () => {
  const f = fixture();
  await f.request("/runs", f.task);
  const result = await f.request("/browser", {
    run: f.task.run,
    account: f.task.account,
    action: { kind: "post", text: "Not submitted" },
    id: "action",
  });
  expect(result.status).toBe(423);
  expect(await result.json()).toEqual({
    error: "SOCIAL_AUTH_REQUIRED",
    status: { state: "code_required", hasCredentials: true },
  });
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      requestId: result.headers.get("x-request-id"),
      stage: "login.required",
      causeCode: "code_required",
    }),
  );
  await f.request("/cancel", { accountId: f.account.id });
});
