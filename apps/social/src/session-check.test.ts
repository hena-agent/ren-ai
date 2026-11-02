import { expect, test, vi } from "vitest";
import { authFixture } from "../test/auth.test-helper.ts";
import { AuthenticationError } from "./auth-store.ts";
import { socialAuthentication } from "./authentication.ts";

test.each(["x", "threads"] as const)(
  "%s live checks and login requests reuse the right authenticated session without reading credentials",
  async (platform) => {
    for (const kind of ["check", "login"] as const) {
      const f = authFixture(platform);
      f.setCredentials(false);
      f.screens("authenticated");
      f.store.load = vi.fn<typeof f.store.load>(async () => {
        throw new Error("Must not read credentials");
      });
      const result = await f.auth.submit(f.account, { kind }, "existing-session");
      expect(result.state).toBe(kind === "check" ? "checking" : "logging_in");
      await vi.waitFor(async () =>
        expect(await f.auth.status(f.account)).toEqual({
          state: "authenticated",
          hasCredentials: false,
        }),
      );
      expect(f.store.load).not.toHaveBeenCalled();
      expect(f.inputs).toEqual([]);
      expect(f.commandArgs.some((args) => args[0] === "open")).toBe(false);
      expect(f.notifications).toEqual(["authenticated"]);
    }
  },
);

test("automatic authentication also accepts a live session without a saved password", async () => {
  const f = authFixture();
  f.setCredentials(false);
  f.screens("authenticated");
  await f.auth.ensure(f.account, 1234, new AbortController().signal);
  expect(await f.auth.status(f.account)).toEqual({ state: "authenticated", hasCredentials: false });
});

test("a stale login form is refreshed against the platform home and recognizes a manual login", async () => {
  const f = authFixture("threads");
  const command = f.commands.command;
  f.commands.command = async (...args) => {
    if (args[2][0] === "open" && args[2][1] === "https://www.threads.com/")
      f.screens("authenticated");
    return command(...args);
  };
  await f.auth.submit(f.account, { kind: "check" }, "manual-login");
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
  expect(f.inputs).toEqual([]);
});

test.each([
  ["logged_out", "login_required"],
  ["code", "code_required"],
  ["manual", "manual_required"],
  ["loading", "failed"],
  ["rejected", "failed"],
] as const)(
  "a live %s screen is reported as %s without filling or clicking",
  async (screen, state) => {
    const f = authFixture();
    f.screens(screen);
    await f.auth.submit(f.account, { kind: "check" }, "read-only-check");
    await vi.waitFor(async () => expect((await f.auth.status(f.account)).state).toBe(state));
    expect(f.inputs).toEqual([]);
    expect(f.commandArgs.some((args) => args[0] === "click" || args[0] === "batch")).toBe(false);
  },
);

test("live checks distinguish a mismatched account and unavailable browser from a logged-out session", async () => {
  const f = authFixture("threads");
  f.screens("authenticated");
  f.setHandle("other_account");
  await f.auth.submit(f.account, { kind: "check" }, "wrong-account");
  await vi.waitFor(async () =>
    expect(await f.auth.status(f.account)).toMatchObject({ reason: "account_mismatch" }),
  );
  f.commands.open = async () => {
    throw new Error("Browser unavailable");
  };
  await f.auth.submit(f.account, { kind: "check" }, "browser-offline");
  await vi.waitFor(async () =>
    expect(await f.auth.status(f.account)).toMatchObject({
      state: "failed",
      reason: "check_unavailable",
    }),
  );
  expect(f.inputs).toEqual([]);
});

test("a failed browser probe is diagnosed as a check failure without claiming logout or consuming credentials", async () => {
  const f = authFixture();
  f.commands.command = async () => {
    throw Object.assign(new Error("Cannot inspect browser"), { code: "SOCIAL_BROWSER_COMMAND" });
  };
  await f.auth.submit(f.account, { kind: "check" }, "probe-failed");
  await vi.waitFor(async () =>
    expect(await f.auth.status(f.account)).toMatchObject({
      state: "failed",
      reason: "check_unavailable",
    }),
  );
  expect(f.failureEvents[0]).toMatchObject({
    requestId: "probe-failed",
    stage: "login.execute",
    diagnostic: { causeCode: "SOCIAL_BROWSER_COMMAND" },
  });
  expect(f.inputs).toEqual([]);
});

test("a login without stored credentials reports configuration needed only after finding a logged-out browser", async () => {
  const f = authFixture();
  f.setCredentials(false);
  f.screens("logged_out");
  await expect(f.auth.ensure(f.account, 1234, new AbortController().signal)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect(await f.auth.status(f.account)).toEqual({
    state: "not_configured",
    hasCredentials: false,
  });
  expect(f.inputs).toEqual([]);
});

test("a queued check exposes its own busy state, rejects duplicate work and becomes interrupted after replacement", async () => {
  const f = authFixture();
  f.screens("authenticated");
  let release!: () => void;
  const pending = new Promise<void>((done) => {
    release = done;
  });
  f.commands.open = async () => {
    await pending;
    return 1234;
  };
  await f.auth.submit(f.account, { kind: "check" }, "slow-check");
  expect((await f.auth.status(f.account)).state).toBe("checking");
  await expect(f.auth.submit(f.account, { kind: "login" }, "duplicate")).rejects.toThrow(
    "in progress",
  );
  const replacement = socialAuthentication(f.options);
  expect(await replacement.status(f.account)).toMatchObject({
    state: "login_required",
    reason: "interrupted",
  });
  release();
  await vi.waitFor(async () =>
    expect((await f.auth.status(f.account)).state).toBe("authenticated"),
  );
});
