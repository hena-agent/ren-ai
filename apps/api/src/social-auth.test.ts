import { expect, test, vi } from "vitest";
import { SocialAuthStatus } from "@ren-ai/onboarding/social-auth";
import { socialAuthAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { socialTestContext, socialGate } from "../test/social.test-helper.ts";
import { createSocial } from "./social/http.ts";
import { SocialError } from "./social/service.ts";

const { fixture, logs } = socialTestContext();
async function beginLogin(f: ReturnType<typeof fixture>) {
  f.options.authenticate = async () => ({ state: "logging_in", hasCredentials: true });
  await f.request("/auth", { accountId: "first", command: { kind: "login" } });
}
const credentials = {
  kind: "save",
  username: "PRIVATE_LOGIN@example.test",
  password: "PRIVATE_PASSWORD",
} as const;

test("credentials travel transiently to the Mac, fencing activity without entering durable accounts or action history", async () => {
  const f = fixture();
  await f.enable();
  f.options.authenticate = vi.fn<typeof f.options.authenticate>(async () => ({
    state: "logging_in",
    hasCredentials: false,
  }));
  expect((await f.request("/auth", { accountId: "first", command: credentials })).status).toBe(200);
  expect(f.options.authenticate).toHaveBeenCalledWith(
    socialAuthAccount,
    credentials,
    expect.any(String),
  );
  expect((await f.request("/control", { runId: f.started[0] })).status).toBe(409);
  expect((await f.snapshot()).accounts[0]).toMatchObject({ state: "login_required" });
  expect(JSON.stringify(f.db.prepare("SELECT * FROM social_account").all())).not.toContain(
    "PRIVATE",
  );
  expect(JSON.stringify(f.db.prepare("SELECT * FROM social_event").all())).not.toContain("PRIVATE");
  expect(logs.join("")).not.toContain("PRIVATE");
  expect((await f.request("/now", { accountId: "first" })).status).toBe(409);
});

test("persisted login probes recover callback loss across actor replacement without starting activity early", async () => {
  const f = fixture();
  await f.enable();
  let state: typeof SocialAuthStatus.Type = { state: "logging_in", hasCredentials: true };
  f.options.authenticate = async () => state;
  await f.request("/auth", { accountId: "first", command: { kind: "login" } });
  f.advance(31000);
  await createSocial(f.storage, f.options).alarm();
  expect(f.started).toHaveLength(1);
  expect(f.alarm()).toBeGreaterThan(f.options.now());
  state = { state: "authenticated", hasCredentials: true };
  f.advance(31000);
  await createSocial(f.storage, f.options).alarm();
  await f.app.alarm();
  expect(f.started).toHaveLength(2);
});

test("extra authentication pauses until verified current-account completion; stale callbacks cannot resume another assignment", async () => {
  const f = fixture();
  await f.enable();
  await beginLogin(f);
  f.options.authenticate = async () => ({ state: "code_required", hasCredentials: true });
  f.advance(31000);
  await f.app.alarm();
  expect(f.alarm()).toBeNull();
  await f.request("/authenticated", socialAuthAccount);
  expect(f.alarm()).toBeNull();
  f.options.authenticate = async () => ({ state: "authenticated", hasCredentials: true });
  await f.request("/authenticated", { ...socialAuthAccount, generation: 2 });
  expect(f.alarm()).toBeNull();
  await f.request("/authenticated", socialAuthAccount);
  expect((await f.snapshot()).accounts[0]?.state).toBe("scheduled");
  await f.request("/authenticated", socialAuthAccount);
  expect((await f.snapshot()).accounts[0]?.state).toBe("scheduled");
});

test("pre-submit authentication failures release only unsent write reservations and retain uncertain writes", async () => {
  const f = fixture();
  await f.enable();
  f.options.browser = async () => {
    throw new SocialError(423, "SOCIAL_AUTH_REQUIRED");
  };
  expect((await f.action(0, { kind: "post", text: "Invitation" })).status).toBe(423);
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    state: "login_required",
    writes: 0,
    nextAt: null,
  });
  expect((await f.action(0, { kind: "post", text: "Invitation" })).status).toBe(200);
  f.options.authenticate = async () => ({ state: "authenticated", hasCredentials: true });
  await f.request("/authenticated", socialAuthAccount);
  await f.app.alarm();
  f.options.browser = async () => ({ text: "Published" });
  expect(
    (
      await f.request("/actions", {
        runId: f.started[1],
        step: 0,
        decision: { action: { kind: "post", text: "Invitation" }, reason: "Resume" },
      })
    ).status,
  ).toBe(200);
  const read = fixture();
  await read.enable();
  read.options.browser = async () => {
    throw new SocialError(423, "SOCIAL_AUTH_REQUIRED");
  };
  expect((await read.action(0, { kind: "notifications" })).status).toBe(423);
  expect((await read.snapshot()).accounts[0]?.writes).toBe(0);
});

test("deleting stored login information stops activity and never turns on an initially disabled account", async () => {
  const f = fixture();
  await f.enable();
  f.options.authenticate = async () => ({ state: "not_configured", hasCredentials: false });
  await f.request("/auth", { accountId: "first", command: { kind: "forget" } });
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    state: "paused",
    nextAt: null,
    account: { enabled: false },
  });
  f.options.authenticate = async () => ({ state: "authenticated", hasCredentials: true });
  await f.request("/auth", { accountId: "first", command: { kind: "login" } });
  await f.request("/authenticated", socialAuthAccount);
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    state: "paused",
    nextAt: null,
    account: { enabled: false },
  });
});

test("read-only status, missing accounts, invalid secrets and unavailable probes stay bounded and private", async () => {
  const f = fixture();
  expect((await f.request("/auth", { accountId: "missing", command: credentials })).status).toBe(
    404,
  );
  await f.request("/authenticated", { ...socialAuthAccount, id: "missing" });
  await f.enable();
  expect(
    (
      await f.request("/auth", {
        accountId: "first",
        command: { kind: "save", password: "PRIVATE" },
      })
    ).status,
  ).toBe(400);
  await f.request("/auth", { accountId: "first", command: { kind: "status" } });
  expect((await f.snapshot()).accounts[0]?.state).toBe("running");
  f.options.authenticate = async () => ({ state: "logging_in", hasCredentials: true });
  await f.request("/auth", { accountId: "first", command: { kind: "code", code: "123456" } });
  f.options.authenticate = async () => {
    throw new Error("PRIVATE_MAC_RESPONSE");
  };
  f.advance(31000);
  await f.app.alarm();
  expect(f.alarm()).toBeGreaterThan(f.options.now());
  expect(logs.join("")).not.toContain("PRIVATE");
});

test.each([false, true])(
  "connection changes while cancelling cannot be overwritten by old results (restored config: %s)",
  async (restored) => {
    const f = fixture();
    await f.enable();
    const account = (await f.snapshot()).accounts[0]!.account;
    const hold = socialGate<void>();
    f.options.cancel = async () => hold.promise;
    const request = f.request("/auth", { accountId: "first", command: credentials });
    await vi.waitFor(() =>
      expect(f.db.prepare("SELECT state FROM social_account").get()).toMatchObject({
        state: "login_required",
      }),
    );
    await f.request("/accounts", {
      ...(await f.snapshot()).accounts[0]!.account,
      personaId: "bob",
    });
    if (restored) await f.request("/accounts", account);
    hold.resolve();
    expect((await request).status).toBe(409);
    expect((await f.snapshot()).accounts[0]?.account.personaId).toBe(
      restored ? account.personaId : "bob",
    );
  },
);

test.each([false, true])(
  "a delayed forget response cannot overwrite connection edits (reassigned: %s)",
  async (reassigned) => {
    const f = fixture();
    await f.enable();
    const hold = socialGate<typeof SocialAuthStatus.Type>();
    f.options.authenticate = vi.fn<typeof f.options.authenticate>(async () => hold.promise);
    const request = f.request("/auth", { accountId: "first", command: { kind: "forget" } });
    await vi.waitFor(() => expect(f.options.authenticate).toHaveBeenCalled());
    const account = (await f.snapshot()).accounts[0]!.account;
    const changed = {
      ...account,
      ...(reassigned ? { personaId: "bob" } : { intervalMinutes: account.intervalMinutes + 1 }),
    };
    await f.request("/accounts", changed);
    hold.resolve({ state: "not_configured", hasCredentials: false });
    expect((await request).status).toBe(409);
    expect((await f.snapshot()).accounts[0]?.account).toEqual(changed);
  },
);

test.each(["state", "config", "generation"])(
  "an in-flight authentication probe respects a changed %s fence",
  async (change) => {
    const f = fixture();
    await f.enable();
    await beginLogin(f);
    const hold = socialGate<typeof SocialAuthStatus.Type>();
    f.options.authenticate = vi.fn<typeof f.options.authenticate>(async () => hold.promise);
    f.advance(31000);
    const alarm = f.app.alarm();
    await vi.waitFor(() => expect(f.options.authenticate).toHaveBeenCalled());
    const account = (await f.snapshot()).accounts[0]!.account;
    if (change === "generation") {
      await f.request("/accounts", { ...account, personaId: "bob" });
      await f.request("/accounts", account);
    } else
      await f.request(
        "/accounts",
        change === "state"
          ? { ...account, enabled: false }
          : { ...account, intervalMinutes: account.intervalMinutes + 1 },
      );
    const before = (await f.snapshot()).accounts[0];
    hold.resolve({ state: "authenticated", hasCredentials: true });
    await alarm;
    expect((await f.snapshot()).accounts[0]).toEqual(before);
  },
);

test("a successful recovery probe preserves a disabled account", async () => {
  const f = fixture();
  await f.enable({ enabled: false });
  await beginLogin(f);
  f.options.authenticate = async () => ({ state: "authenticated", hasCredentials: true });
  f.advance(31000);
  await f.app.alarm();
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    state: "paused",
    nextAt: null,
    account: { enabled: false },
  });
});
