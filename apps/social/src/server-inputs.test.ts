import { afterEach, expect, test, vi } from "vitest";
import { socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
import { AuthenticationError } from "./auth-store.ts";
import type { SocialApplication } from "./client.ts";
import { socialExecutor } from "./server.ts";
import type { SocialModel } from "./model.ts";
import { socialBrowser } from "./browser.ts";
import { serverAuthStub } from "../test/server.test-helper.ts";
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const task = socialTask();
  const application: SocialApplication = {
    image: async (_run, id) => ({ id, data: "", mime: "image/jpeg" }),
    progress: async () => {},
    authenticated: async () => {},
    control: async () => ({ run: task.run, account: task.account }),
    action: async () => ({ text: "ok" }),
    complete: async () => {},
  };
  const model: SocialModel = {
    model: "test",
    decide: async (_task, _run, _observation, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true }),
      ),
    interrupt: async () => {},
  };
  const browser = vi.fn<ReturnType<typeof socialBrowser>["execute"]>(async () => ({ text: "ok" }));
  const handle = socialExecutor({
    token: "secret",
    application,
    model,
    browser: { open: async () => 1234, execute: browser },
    authentication: serverAuthStub,
    readiness: async () => ({ chromeCanary: true, agentBrowser: true, openCode: true }),
    log: () => {},
  });
  return { task, browser, handle };
}

test.each(["content-length", "stream"] as const)(
  "oversized %s browser requests are rejected before parsing unbounded bodies",
  async (mode) => {
    const f = fixture();
    const request =
      mode === "content-length"
        ? new Request("https://social.test/browser", {
            method: "POST",
            headers: { Authorization: "Bearer secret", "Content-Length": "15000000" },
            body: "{}",
          })
        : new Request("https://social.test/browser", {
            method: "POST",
            headers: { Authorization: "Bearer secret" },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(14200001));
                controller.close();
              },
            }),
            duplex: "half",
          });
    expect((await f.handle(request)).status).toBe(503);
    expect(f.browser).not.toHaveBeenCalled();
  },
);

test("a bodyless POST returns a sanitized input failure and cancel errors cannot leak stream text", async () => {
  const f = fixture();
  const missing = await f.handle(
    new Request("https://social.test/auth", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    }),
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(14200001));
    },
    cancel() {
      throw new Error("PRIVATE_STREAM_CONTENT");
    },
  });
  const oversized = await f.handle(
    new Request("https://social.test/browser", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body,
      duplex: "half",
    }),
  );
  expect([missing.status, oversized.status]).toEqual([503, 503]);
  expect(await oversized.text()).not.toContain("PRIVATE_STREAM_CONTENT");
});
test.each(["body", "reader"] as const)(
  "rejected %s cancellation promises are consumed safely",
  async (kind) => {
    const f = fixture();
    const target =
      kind === "body" ? ReadableStream.prototype : ReadableStreamDefaultReader.prototype;
    vi.spyOn(target, "cancel").mockRejectedValue(new Error("private cancel rejection"));
    const payload =
      kind === "body"
        ? "{}"
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(14200001));
            },
          });
    const request = new Request(`https://social.test/${kind === "body" ? "browser" : "browser"}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        ...(kind === "body" && { "Content-Length": "15000000" }),
      },
      body: payload,
      duplex: "half",
    });
    const response = await f.handle(request);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private cancel rejection");
  },
);

test("a manual auth challenge preserves its typed response and does not publish", async () => {
  const f = fixture();
  const queued = await f.handle(
    new Request("https://social.test/runs", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify(f.task),
    }),
  );
  expect(queued.status).toBe(202);
  f.browser.mockRejectedValue(
    new AuthenticationError({ state: "code_required", hasCredentials: true }),
  );
  const response = await f.handle(
    new Request("https://social.test/browser", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        run: f.task.run,
        account: f.task.account,
        action: { kind: "post", text: "draft" },
        id: "action",
      }),
    }),
  );
  expect(response.status).toBe(423);
  expect(await response.json()).toMatchObject({
    error: "SOCIAL_AUTH_REQUIRED",
    status: { state: "code_required" },
  });
  const cancelled = await f.handle(
    new Request("https://social.test/cancel", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: f.task.account.id }),
    }),
  );
  expect(cancelled.status).toBe(204);
});
test("valid authentication status requests return the status and correlate the request", async () => {
  const f = fixture();
  const response = await f.handle(
    new Request("https://social.test/auth", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "X-Operation-ID": "10000000-0000-4000-8000-000000000001",
      },
      body: JSON.stringify({
        account: {
          id: "first",
          platform: "threads",
          handle: "",
          personaId: "alice",
          generation: 1,
        },
        command: { kind: "status" },
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "not_configured", hasCredentials: false });
});
