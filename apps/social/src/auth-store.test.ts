import { createCipheriv } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { socialAuthAccount as account } from "../../../packages/onboarding/src/social.test-helper.ts";
import { privateLogin } from "../test/auth.test-helper.ts";
import { authStore, AuthenticationError } from "./auth-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "social-vault-"));
  roots.push(home);
  const directory = join(home, "agent-browser", ".agent-browser");
  await mkdir(join(directory, "auth"), { recursive: true, mode: 0o700 });
  const key = "ab".repeat(32);
  await writeFile(join(directory, ".encryption-key"), key, { mode: 0o600 });
  const profile = join(directory, "auth", "renai-x-first.json");
  const encrypt = (value: object) => {
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return JSON.stringify({
      version: 1,
      encrypted: true,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  };
  const credentials = {
    name: "renai-x-first",
    url: `https://x.com/i/flow/login#renai-account=${account.handle}`,
    username: privateLogin.username,
    password: privateLogin.password,
  };
  return {
    home,
    directory,
    profile,
    key,
    encrypt,
    credentials,
    store: authStore(home),
  };
}

test("agent-browser's encrypted vault survives replacement while password input stays out of argv and metadata", async () => {
  const f = await fixture();
  expect(await f.store.state(account)).toEqual({ state: "not_configured", hasCredentials: false });
  await f.store.save(account, privateLogin);
  const encrypted = await readFile(f.profile, "utf8");
  expect(encrypted).not.toContain(privateLogin.password);
  expect(encrypted).not.toContain(privateLogin.username);
  expect((await stat(f.profile)).mode & 0o777).toBe(0o600);
  expect(await authStore(f.home).load(account)).toEqual({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect(await authStore(f.home, f.key).load(account)).toEqual({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect(await f.store.state(account)).toEqual({ state: "login_required", hasCredentials: true });
  await f.store.update(account, { state: "authenticated", hasCredentials: true });
  expect((await authStore(f.home).state(account)).state).toBe("authenticated");
  const metadata = await readFile(join(f.home, "auth-state", "first.json"), "utf8");
  expect(metadata).not.toContain(privateLogin.password);
  expect(metadata).not.toContain(privateLogin.username);
  expect((await f.store.state({ ...account, generation: 2 })).state).toBe("login_required");
  expect((await f.store.state({ ...account, handle: "other" })).state).toBe("login_required");
  await f.store.forget(account);
  expect(await f.store.state(account)).toEqual({ state: "not_configured", hasCredentials: false });
  expect(await readFile(join(f.directory, ".encryption-key"), "utf8")).toBe(f.key);
});

test("concurrent account saves publish one encryption key and retain both readable profiles", async () => {
  const f = await fixture();
  await rm(join(f.directory, ".encryption-key"));
  const second = { ...account, id: "second", handle: "other" };
  await Promise.all([f.store.save(account, privateLogin), f.store.save(second, privateLogin)]);
  expect(await f.store.load(account)).toEqual({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect(await f.store.load(second)).toEqual({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect((await stat(join(f.directory, ".encryption-key"))).mode & 0o777).toBe(0o600);
});

test("plaintext, corrupted encryption, wrong account bindings and malformed keys fail closed without secret errors", async () => {
  const f = await fixture();
  for (const payload of [
    JSON.stringify(f.credentials),
    "bad JSON",
    f.encrypt({ ...f.credentials, name: "other" }),
    f.encrypt({ ...f.credentials, url: "https://evil.test" }),
  ]) {
    await writeFile(f.profile, payload);
    await expect(f.store.load(account)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(f.store.load(account)).rejects.toMatchObject({
      message: "X authentication requires operator attention",
      code: "SOCIAL_AUTH_REQUIRED",
    });
  }
  await writeFile(f.profile, f.encrypt(f.credentials));
  await expect(authStore(f.home, "bad-key").load(account)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  await expect(authStore(f.home, "cd".repeat(32)).load(account)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  await rm(f.profile);
  await f.store.update(account, { state: "authenticated", hasCredentials: false });
  expect((await f.store.state({ ...account, generation: 2 })).state).toBe("not_configured");
});

test("failed atomic state writes remove staging files", async () => {
  const f = await fixture();
  await mkdir(join(f.home, "auth-state", "first.json"), { recursive: true });
  await expect(
    f.store.update(account, { state: "authenticated", hasCredentials: true }),
  ).rejects.toThrow(Error);
  await f.store.forget({ ...account, id: "missing" });
});

test("credentials persist without requiring a browser or CLI to be installed", async () => {
  const f = await fixture();
  await f.store.save(account, privateLogin);
  expect(await f.store.load(account)).toMatchObject({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect(await f.store.has(account)).toBe(true);
});

test("first discovery retains a readable bound vault and identity across restarts and subsequent login failures", async () => {
  const f = await fixture();
  const pending = { ...account, handle: "" };
  await f.store.save(pending, privateLogin);
  await f.store.update(pending, {
    state: "logging_in",
    hasCredentials: true,
    handle: account.handle,
  });
  expect((await authStore(f.home).load(account)).password).toBe(privateLogin.password);
  await expect(f.store.load({ ...account, handle: "different" })).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  await f.store.save(account, await f.store.load(pending));
  await f.store.update(pending, {
    state: "authenticated",
    hasCredentials: true,
    handle: account.handle,
  });
  const restarted = authStore(f.home);
  expect((await restarted.state(account)).state).toBe("authenticated");
  expect((await restarted.load(account)).password).toBe(privateLogin.password);
  expect((await restarted.load(pending)).password).toBe(privateLogin.password);
  await restarted.update(pending, { state: "logging_in", hasCredentials: true });
  await restarted.update(pending, {
    state: "failed",
    hasCredentials: true,
    reason: "credentials_rejected",
  });
  expect((await restarted.state(pending)).handle).toBe(account.handle);
  await restarted.save(pending, privateLogin);
  expect((await restarted.load(account)).password).toBe(privateLogin.password);
  await expect(restarted.load({ ...account, handle: "different" })).rejects.toBeInstanceOf(
    AuthenticationError,
  );
});

test("X and Threads with the same account ID keep independent vault profiles and saved login states", async () => {
  const f = await fixture();
  const threads = { ...account, platform: "threads" as const };
  await f.store.save(account, privateLogin);
  await f.store.save(threads, { username: "threads.login", password: "THREADS_PRIVATE" });
  await f.store.update(account, { state: "authenticated", hasCredentials: true });
  await f.store.update(threads, {
    state: "failed",
    reason: "credentials_rejected",
    hasCredentials: true,
  });
  expect((await f.store.load(account)).password).toBe(privateLogin.password);
  expect((await f.store.load(threads)).password).toBe("THREADS_PRIVATE");
  expect((await f.store.state(threads)).state).toBe("failed");
  await f.store.forget(threads);
  expect(await f.store.state(threads)).toEqual({ state: "not_configured", hasCredentials: false });
  expect((await f.store.state(account)).state).toBe("authenticated");
});
