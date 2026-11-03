import { expect, test, vi } from "vitest";
import { authFixture, privateLogin } from "../test/auth.test-helper.ts";

test.each(["x", "threads"] as const)(
  "%s discovers the first session identity without asking for a handle",
  async (platform) => {
    const f = authFixture(platform);
    const account = { ...f.account, handle: "" };
    f.setCredentials(false);
    f.screens("authenticated");
    await f.auth.submit(account, { kind: "check" }, "discover");
    await vi.waitFor(async () =>
      expect(await f.auth.status(account)).toEqual({
        state: "authenticated",
        hasCredentials: false,
        handle: f.account.handle,
      }),
    );
    expect(f.inputs).toEqual([]);
    expect(f.notifications).toEqual(["authenticated"]);
  },
);

test("first credential login rebinds the encrypted vault to the discovered account", async () => {
  const f = authFixture("threads");
  const account = { ...f.account, handle: "" };
  f.store.save = vi.fn<typeof f.store.save>(async () => {});
  await f.auth.submit(account, { kind: "login" }, "discover-login");
  await vi.waitFor(async () =>
    expect((await f.auth.status(account)).handle).toBe(f.account.handle),
  );
  expect(f.store.save).toHaveBeenCalledWith(
    { ...account, handle: f.account.handle },
    { username: privateLogin.username, password: privateLogin.password },
  );
});

test("a previously discovered identity still rejects another account before Cloudflare adopts the handle", async () => {
  const f = authFixture("threads");
  const account = { ...f.account, handle: "" };
  f.setState({ state: "authenticated", hasCredentials: false, handle: f.account.handle });
  const update = f.store.update;
  f.store.update = async (identity, state) =>
    update(identity, { ...state, handle: f.account.handle });
  f.setCredentials(false);
  f.screens("authenticated");
  f.setHandle("another_account");
  await f.auth.submit(account, { kind: "check" }, "mismatch");
  await vi.waitFor(async () =>
    expect((await f.auth.status(account)).reason).toBe("account_mismatch"),
  );
  expect(f.notifications).toEqual([]);
});

test.each(["bad/path", "", "a".repeat(31), "name.with.dots"])(
  "X never confirms an invalid discovered handle (%s)",
  async (handle) => {
    const f = authFixture();
    const account = { ...f.account, handle: "" };
    f.screens("authenticated");
    f.setHandle(handle);
    await f.auth.submit(account, { kind: "check" }, "invalid");
    await vi.waitFor(async () => expect((await f.auth.status(account)).reason).toBe("unavailable"));
    expect(f.notifications).toEqual([]);
  },
);

test("an X username challenge before discovery requires manual attention rather than submitting an empty handle", async () => {
  const f = authFixture();
  f.screens("identity");
  await f.auth.submit({ ...f.account, handle: "" }, { kind: "login" }, "challenge");
  await vi.waitFor(async () =>
    expect((await f.auth.status({ ...f.account, handle: "" })).state).toBe("manual_required"),
  );
  expect(f.inputs).toEqual([]);
});
