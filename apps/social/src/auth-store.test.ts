import { createCipheriv } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { socialAuthAccount as account } from "../../../packages/onboarding/src/social.test-helper.ts";
import { privateLogin } from "../test/auth.test-helper.ts";
import { authStore, AuthenticationError } from "./auth-store.ts";
import type { BrowserCommands } from "./commands.ts";

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
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
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
  const commands: BrowserCommands = {
    open: async () => 1234,
    command: async (_account, _port, args, _signal, input) => {
      calls.push({ args, input });
      return "agent-browser 0.41.0";
    },
  };
  return {
    home,
    directory,
    profile,
    key,
    calls,
    encrypt,
    credentials,
    commands,
    store: authStore(home, commands),
  };
}

test("agent-browser's encrypted vault survives replacement while password input stays out of argv and metadata", async () => {
  const f = await fixture();
  expect(await f.store.state(account)).toEqual({ state: "not_configured", hasCredentials: false });
  await f.store.save(account, privateLogin, 1234, new AbortController().signal);
  expect(f.calls).toEqual([{ args: ["--version"], input: undefined }]);
  expect(JSON.stringify(f.calls)).not.toContain(privateLogin.username);
  expect(JSON.stringify(f.calls)).not.toContain(privateLogin.password);
  const encrypted = await readFile(f.profile, "utf8");
  expect(encrypted).not.toContain(privateLogin.password);
  expect(encrypted).not.toContain(privateLogin.username);
  expect((await stat(f.profile)).mode & 0o777).toBe(0o600);
  expect(await authStore(f.home, f.commands).load(account)).toEqual({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect(await authStore(f.home, f.commands, f.key).load(account)).toEqual({
    username: privateLogin.username,
    password: privateLogin.password,
  });
  expect(await f.store.state(account)).toEqual({ state: "login_required", hasCredentials: true });
  await f.store.update(account, { state: "authenticated", hasCredentials: true });
  expect((await authStore(f.home, f.commands).state(account)).state).toBe("authenticated");
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
  await Promise.all([
    f.store.save(account, privateLogin, 1234, new AbortController().signal),
    f.store.save(second, privateLogin, 1234, new AbortController().signal),
  ]);
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
  await expect(authStore(f.home, f.commands, "bad-key").load(account)).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  await expect(authStore(f.home, f.commands, "cd".repeat(32)).load(account)).rejects.toBeInstanceOf(
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

test("an unsupported CLI never receives credentials or creates a plaintext profile", async () => {
  const f = await fixture();
  const inputs: (string | undefined)[] = [];
  f.commands.command = async (_account, _port, _args, _signal, input) => {
    inputs.push(input);
    return "agent-browser 0.40.0";
  };
  await expect(
    f.store.save(account, privateLogin, 1234, new AbortController().signal),
  ).rejects.toThrow("0.41.0 is required");
  expect(inputs).toEqual([undefined]);
  expect(await f.store.has(account)).toBe(false);
});
