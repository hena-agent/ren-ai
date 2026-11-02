import { expect, test, vi } from "vitest";
import { authFixture, privateLogin } from "../test/auth.test-helper.ts";
import { AuthenticationError } from "./auth-store.ts";
import { loginPage } from "./login-page.ts";
import { authStore } from "./auth-store.ts";
import { socialAuthentication } from "./authentication.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("stored credentials automatically restore a session through X's separate login screens", async () => {
  const f = authFixture();
  f.screens("username", "identity", "password", "authenticated");
  await f.auth.ensure(f.account, 1234, new AbortController().signal);
  expect(await f.auth.status(f.account)).toEqual({ state: "authenticated", hasCredentials: true });
  expect(f.inputs).toHaveLength(3);
  expect(f.inputs[0]).toContain(privateLogin.username);
  expect(f.inputs[1]).toContain(f.account.handle);
  expect(f.inputs[2]).toContain(privateLogin.password);
  expect(JSON.stringify(f.commandArgs)).not.toContain(privateLogin.password);
  expect(JSON.stringify(f.notifications)).not.toContain(privateLogin.password);
  expect(f.notifications).toEqual(["authenticated"]);
});

test.each(["x", "threads"] as const)(
  "%s credentials survive browser launch failure and executor replacement, then retry without new secrets",
  async (platform) => {
    const f = authFixture(platform);
    const home = await mkdtemp(join(tmpdir(), "social-save-first-"));
    try {
      f.options.store = authStore(home);
      f.commands.open = async () => {
        expect(await f.options.store.load(f.account)).toMatchObject({
          username: privateLogin.username,
          password: privateLogin.password,
        });
        throw new Error("Canary unavailable");
      };
      await f.auth.submit(f.account, { kind: "save", ...privateLogin }, "save-first");
      await vi.waitFor(async () =>
        expect(await f.auth.status(f.account)).toMatchObject({
          state: "failed",
          hasCredentials: true,
        }),
      );
      expect(await authStore(home).load(f.account)).toMatchObject({
        username: privateLogin.username,
        password: privateLogin.password,
      });
      f.commands.open = async () => 1234;
      const restarted = socialAuthentication({ ...f.options, store: authStore(home) });
      await restarted.submit(f.account, { kind: "login" }, "retry-saved");
      await vi.waitFor(async () =>
        expect((await restarted.status(f.account)).state).toBe("authenticated"),
      );
      expect(JSON.stringify(f.commandArgs)).not.toContain(privateLogin.password);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("Threads fills both Instagram credential fields in one private batch and pauses for a verification code", async () => {
  const f = authFixture("threads");
  f.screens("credentials", "code", "authenticated");
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]).toContain(privateLogin.username);
  expect(f.inputs[0]).toContain(privateLogin.password);
  expect(await f.auth.status(f.account)).toMatchObject({
    state: "code_required",
    hasCredentials: true,
  });
  await f.auth.submit(f.account, { kind: "code", code: privateLogin.code }, "threads-code");
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
});

test("an unsupported browser CLI blocks login after saving credentials and keeps an explicit retry available", async () => {
  const f = authFixture("threads");
  f.setCredentials(false);
  f.commands.command = async () => "agent-browser 0.40.0";
  await f.auth.submit(f.account, { kind: "save", ...privateLogin }, "old-cli");
  await vi.waitFor(async () =>
    expect(await f.auth.status(f.account)).toMatchObject({ state: "failed", hasCredentials: true }),
  );
  expect(f.inputs).toEqual([]);
  const working = authFixture("threads");
  f.commands.command = working.commands.command;
  await f.auth.submit(f.account, { kind: "login" }, "updated-cli");
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
});

test("verification codes pause automatic login, persist attention state and continue only after operator input", async () => {
  const f = authFixture();
  f.screens("username", "password", "code", "authenticated");
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect((await f.auth.status(f.account)).state).toBe("code_required");
  const before = f.inputs.length;
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect(f.inputs).toHaveLength(before);
  expect(
    await f.auth.submit(f.account, { kind: "code", code: privateLogin.code }, "request"),
  ).toMatchObject({ state: "logging_in" });
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
  expect(f.inputs.at(-1)).toContain(privateLogin.code);
  expect(JSON.stringify(f.commandArgs)).not.toContain(privateLogin.code);
});

test.each([
  ["manual", "manual_required"],
  ["rejected", "failed"],
  ["loading", "failed"],
])("%s requires attention and does not repeatedly submit passwords", async (screen, state) => {
  const f = authFixture();
  f.screens(screen);
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect((await f.auth.status(f.account)).state).toBe(state);
  expect(f.inputs).toHaveLength(0);
});

test("replaced login origins, mismatched accounts and interrupted challenges never consume another code", async () => {
  const wrongOrigin = authFixture();
  wrongOrigin.setOrigin("https://evil.test");
  await expect(
    wrongOrigin.auth.ensure(wrongOrigin.account, 1234, new AbortController().signal),
  ).rejects.toBeInstanceOf(AuthenticationError);
  expect(wrongOrigin.inputs).toEqual([]);
  const mismatch = authFixture();
  mismatch.screens("authenticated");
  mismatch.setHandle("other");
  await expect(
    mismatch.auth.ensure(mismatch.account, 1234, new AbortController().signal),
  ).rejects.toBeInstanceOf(AuthenticationError);
  expect((await mismatch.auth.status(mismatch.account)).reason).toBe("account_mismatch");
  const stale = authFixture();
  stale.setState({ state: "code_required", hasCredentials: true });
  await stale.auth.submit(stale.account, { kind: "code", code: privateLogin.code }, "request");
  await vi.waitFor(async () =>
    expect((await stale.auth.status(stale.account)).state).toBe("manual_required"),
  );
  expect(stale.inputs).toEqual([]);
});

test("credential changes are queued once, and deletion shares the browser's account queue", async () => {
  const f = authFixture();
  f.setCredentials(false);
  expect(
    await f.auth.submit(f.account, { kind: "save", ...privateLogin }, "request"),
  ).toMatchObject({ state: "logging_in" });
  await expect(f.auth.submit(f.account, { kind: "login" }, "duplicate")).rejects.toThrow(
    "in progress",
  );
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
  expect(await f.auth.submit(f.account, { kind: "status" }, "request")).toMatchObject({
    hasCredentials: true,
  });
  expect(await f.auth.submit(f.account, { kind: "forget" }, "request")).toEqual({
    state: "not_configured",
    hasCredentials: false,
  });
  await f.auth.ensure(f.account, 1234, new AbortController().signal);
  expect(await f.auth.status(f.account)).toEqual({ state: "authenticated", hasCredentials: false });
  await expect(f.auth.submit(f.account, { kind: "code", code: "1234" }, "request")).rejects.toThrow(
    "No verification",
  );
});

test("stalled fields are submitted once and missing submit controls stop at a bounded manual step", async () => {
  const f = authFixture();
  f.setAdvance(false);
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect(f.inputs).toHaveLength(1);
  const missing = authFixture();
  missing.setSubmit(false);
  await expect(
    missing.auth.ensure(missing.account, 1234, new AbortController().signal),
  ).rejects.toBeInstanceOf(AuthenticationError);
  expect(missing.inputs).toEqual([]);
});

test("restarts retain credentials but expose interrupted logins rather than retrying blindly", async () => {
  const f = authFixture();
  f.setState({ state: "logging_in", hasCredentials: true });
  expect(await f.auth.status(f.account)).toMatchObject({
    state: "login_required",
    reason: "interrupted",
  });
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect(f.inputs).toEqual([]);
  f.screens("authenticated");
  await f.auth.submit(f.account, { kind: "login" }, "request");
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
});

test("callback delivery failure leaves a verified browser session usable for durable recovery probes", async () => {
  const f = authFixture();
  f.options.authenticated = async () => {
    throw new Error("offline");
  };
  await f.auth.ensure(f.account, 1234, new AbortController().signal);
  expect(await f.auth.status(f.account)).toMatchObject({ state: "authenticated" });
  expect(f.failures).toEqual(["unavailable"]);
});

test("private stdin responses are discarded and bad command results never echo secrets", async () => {
  const f = authFixture();
  f.commands.command = async () => '[{"success":false,"data":{"value":"PRIVATE_ECHO"}}]';
  await expect(
    loginPage(f.commands, "first", 1234, new AbortController().signal).enter(privateLogin.password),
  ).rejects.toThrow("Private login input failed");
  f.commands.command = async () => "bad JSON PRIVATE_ECHO";
  await expect(
    loginPage(f.commands, "first", 1234, new AbortController().signal).enter(privateLogin.password),
  ).rejects.toThrow("Private login input failed");
  const controller = new AbortController();
  controller.abort();
  await expect(
    loginPage(f.commands, "first", 1234, controller.signal).enter(privateLogin.password),
  ).rejects.toThrow("aborted");
});

test("failed credential persistence preserves safe cause diagnostics and permits an operator retry", async () => {
  const f = authFixture();
  f.store.save = async () => {
    throw Object.assign(new Error(`Disk unavailable ${privateLogin.password}`), { code: "EACCES" });
  };
  await f.auth.submit(f.account, { kind: "save", ...privateLogin }, "save-request");
  await vi.waitFor(() => expect(f.failureEvents).toHaveLength(1));
  expect(f.failureEvents[0]).toMatchObject({
    requestId: "save-request",
    stage: "login.prepare",
    diagnostic: { causeCode: "EACCES" },
  });
  expect(JSON.stringify(f.failureEvents)).not.toContain(privateLogin.password);
  await vi.waitFor(async () => expect((await f.auth.status(f.account)).state).toBe("failed"));
  await f.auth.submit(f.account, { kind: "login" }, "retry-request");
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
});

test("background recovery reports both preparation and state-write failures without losing the original cause", async () => {
  const f = authFixture();
  f.commands.open = async () => {
    throw Object.assign(new Error("PRIVATE"), { code: "ECONNREFUSED" });
  };
  const update = f.store.update;
  f.store.update = async (account, status) => {
    if (status.state === "failed") throw Object.assign(new Error("PRIVATE"), { code: "ENOSPC" });
    await update(account, status);
  };
  await f.auth.submit(f.account, { kind: "login" }, "persist-request");
  await vi.waitFor(() => expect(f.failureEvents).toHaveLength(2));
  expect(f.failureEvents.map((event) => [event.stage, event.diagnostic?.causeCode])).toEqual([
    ["login.prepare", "ECONNREFUSED"],
    ["login.persistence", "ENOSPC"],
  ]);
  expect(JSON.stringify(f.failureEvents)).not.toContain("PRIVATE");
  expect(await f.auth.status(f.account)).toMatchObject({ reason: "interrupted" });
});
