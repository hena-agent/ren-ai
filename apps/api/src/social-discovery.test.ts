import { expect, test } from "vitest";
import { socialTestContext, socialAccount } from "../test/social.test-helper.ts";
import { createSocial } from "./social/http.ts";

const { fixture } = socialTestContext();

test("a fast discovery callback can complete before the check acknowledgement without reporting a configuration conflict", async () => {
  const f = fixture();
  await f.enable({ handle: "" });
  f.options.authenticate = async (account, command) => {
    if (command.kind === "check") {
      await f.request("/authenticated", account);
      return { state: "checking", hasCredentials: false };
    }
    return { state: "authenticated", hasCredentials: false, handle: "fast_user" };
  };
  expect(
    (await f.request("/auth", { accountId: "first", command: { kind: "check" } })).status,
  ).toBe(200);
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    account: { handle: "fast_user" },
    state: "scheduled",
  });
});

test("unknown accounts stay blocked, then persist the verified identity and resume after actor replacement", async () => {
  const f = fixture();
  await f.enable({ handle: "" });
  expect(f.started).toEqual([]);
  expect((await f.request("/now", { accountId: "first" })).status).toBe(409);
  f.options.authenticate = async () => ({
    state: "authenticated",
    hasCredentials: false,
    handle: "discovered_user",
  });
  expect(
    (await f.request("/auth", { accountId: "first", command: { kind: "status" } })).status,
  ).toBe(200);
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    account: { handle: "discovered_user", enabled: true },
    generation: 1,
    state: "scheduled",
  });
  await createSocial(f.storage, f.options).alarm();
  expect(f.started).toHaveLength(1);
});

test("a callback discovers disabled connections too, and stale generations cannot bind an identity", async () => {
  const f = fixture();
  await f.request("/accounts", { ...socialAccount, handle: "", enabled: false });
  f.options.authenticate = async () => ({
    state: "authenticated",
    hasCredentials: true,
    handle: "actual_user",
  });
  const callback = { id: "first", platform: "x", handle: "", personaId: "alice", generation: 1 };
  await f.request("/authenticated", { ...callback, generation: 2 });
  expect((await f.snapshot()).accounts[0]?.account.handle).toBe("");
  await f.request("/authenticated", callback);
  expect((await f.snapshot()).accounts[0]).toMatchObject({
    account: { handle: "actual_user", enabled: false },
    state: "paused",
  });
  expect(f.alarm()).toBeNull();
});

test("persisted probes recover discovery callback loss without credentials", async () => {
  const f = fixture();
  await f.enable({ handle: "" });
  f.options.authenticate = async () => ({ state: "checking", hasCredentials: false });
  await f.request("/auth", { accountId: "first", command: { kind: "check" } });
  f.options.authenticate = async () => ({
    state: "authenticated",
    hasCredentials: false,
    handle: "recovered_user",
  });
  f.advance(31000);
  await createSocial(f.storage, f.options).alarm();
  expect((await f.snapshot()).accounts[0]?.account.handle).toBe("recovered_user");
  await f.app.alarm();
  expect(f.started).toHaveLength(1);
});

test("discovered handles are validated and cannot duplicate or overwrite an existing platform identity", async () => {
  const f = fixture();
  await f.enable({ handle: "" });
  f.options.authenticate = async () => ({ state: "authenticated", hasCredentials: false });
  expect(
    await (await f.request("/auth", { accountId: "first", command: { kind: "status" } })).json(),
  ).toMatchObject({ state: "failed", reason: "unavailable" });
  expect((await f.snapshot()).accounts[0]?.account.handle).toBe("");
  f.options.authenticate = async () => ({
    state: "authenticated",
    hasCredentials: false,
    handle: "invalid.x",
  });
  expect(
    (await f.request("/auth", { accountId: "first", command: { kind: "status" } })).status,
  ).toBe(503);
  await f.request("/accounts", { ...socialAccount, id: "known", enabled: false });
  f.options.authenticate = async () => ({
    state: "authenticated",
    hasCredentials: false,
    handle: socialAccount.handle,
  });
  expect(
    (await f.request("/auth", { accountId: "first", command: { kind: "status" } })).status,
  ).toBe(409);
  f.options.authenticate = async () => ({
    state: "authenticated",
    hasCredentials: false,
    handle: "someone_else",
  });
  const response = await f.request("/auth", { accountId: "known", command: { kind: "status" } });
  expect(await response.json()).toMatchObject({ state: "failed", reason: "account_mismatch" });
  expect(
    (await f.snapshot()).accounts.find((row) => row.account.id === "known")?.account.handle,
  ).toBe(socialAccount.handle);
  expect(f.started).toEqual([]);
});
