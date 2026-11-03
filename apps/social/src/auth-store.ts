import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { mkdir, chmod, readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { SocialAuthAccount, SocialAuthStatus } from "@ren-ai/onboarding/social-auth";
import { vaultKey } from "./vault-key.ts";

export class AuthenticationError extends Error {
  readonly code = "SOCIAL_AUTH_REQUIRED";
  constructor(readonly status: SocialAuthStatus) {
    super("X authentication requires operator attention");
  }
}
export class AuthenticationConflict extends Error {
  readonly code = "SOCIAL_AUTH_CONFLICT";
}
const Saved = Schema.Struct({ account: SocialAuthAccount, status: SocialAuthStatus });
const Encrypted = Schema.Struct({
  version: Schema.Literal(1),
  encrypted: Schema.Literal(true),
  iv: Schema.String,
  authTag: Schema.String,
  data: Schema.String,
});
const Credentials = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  username: Schema.String,
  password: Schema.String,
});
type Credentials = Pick<typeof Credentials.Type, "username" | "password">;
export interface AuthStore {
  has: (account: SocialAuthAccount) => Promise<boolean>;
  load: (account: SocialAuthAccount) => Promise<Credentials>;
  save: (account: SocialAuthAccount, credentials: Credentials) => Promise<void>;
  forget: (account: SocialAuthAccount) => Promise<void>;
  state: (account: SocialAuthAccount) => Promise<SocialAuthStatus>;
  update: (account: SocialAuthAccount, status: SocialAuthStatus) => Promise<void>;
}
const unavailable = () =>
  new AuthenticationError({ state: "failed", hasCredentials: true, reason: "unavailable" });
const name = (account: SocialAuthAccount) => `renai-${account.platform}-${account.id}`;
const address = (account: SocialAuthAccount) =>
  `${account.platform === "threads" ? "https://www.threads.com/login" : "https://x.com/i/flow/login"}#renai-account=${account.handle.toLowerCase()}`;

/** Reuse agent-browser's encrypted v1 auth vault; never accept legacy plaintext profiles. */
export function authStore(
  home: string,
  encryptionKey = process.env["AGENT_BROWSER_ENCRYPTION_KEY"],
): AuthStore {
  const vault = join(home, "agent-browser", ".agent-browser");
  const profile = (account: SocialAuthAccount) => join(vault, "auth", `${name(account)}.json`);
  const statePath = (account: SocialAuthAccount) =>
    join(
      home,
      "auth-state",
      `${account.platform === "threads" ? "threads:" : ""}${account.id}.json`,
    );
  const has = (account: SocialAuthAccount) =>
    access(profile(account)).then(
      () => true,
      () => false,
    );
  const state = async (account: SocialAuthAccount): Promise<SocialAuthStatus> => {
    const hasCredentials = await has(account);
    let saved: typeof Saved.Type;
    try {
      saved = Schema.decodeUnknownSync(Schema.fromJsonString(Saved))(
        await readFile(statePath(account), "utf8"),
      );
    } catch {
      return { state: hasCredentials ? "login_required" : "not_configured", hasCredentials };
    }
    if (
      saved.account.platform !== account.platform ||
      saved.account.generation !== account.generation ||
      (account.handle &&
        (saved.status.handle ?? saved.account.handle).toLowerCase() !==
          account.handle.toLowerCase())
    )
      return { state: hasCredentials ? "login_required" : "not_configured", hasCredentials };
    return { ...saved.status, hasCredentials };
  };
  const credentialAddress = async (account: SocialAuthAccount) =>
    address({
      ...account,
      handle: account.handle || (await state(account)).handle || "",
    });
  return {
    has,
    load: async (account) => {
      try {
        const payload = Schema.decodeUnknownSync(Schema.fromJsonString(Encrypted))(
          await readFile(profile(account), "utf8"),
        );
        const key = await vaultKey(vault, encryptionKey);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
        decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
        const value = Schema.decodeUnknownSync(Schema.fromJsonString(Credentials))(
          Buffer.concat([
            decipher.update(Buffer.from(payload.data, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        );
        const discovered = (await state(account)).handle;
        // A verified identity receipt recovers a crash between the two atomic binding writes.
        const interruptedBinding = discovered && value.url === address({ ...account, handle: "" });
        if (
          value.name !== name(account) ||
          (value.url !== (await credentialAddress(account)) && !interruptedBinding)
        )
          throw unavailable();
        return { username: value.username, password: value.password };
      } catch (cause) {
        const error = unavailable();
        const code =
          cause instanceof Error &&
          "code" in cause &&
          typeof cause.code === "string" &&
          /^[A-Z0-9_]{1,80}$/.test(cause.code)
            ? cause.code
            : "SOCIAL_VAULT_INVALID";
        error.cause = Object.assign(new Error("Cannot read encrypted credential vault"), { code });
        throw error;
      }
    },
    save: async (account, credentials) => {
      const url = await credentialAddress(account);
      const key = await vaultKey(vault, encryptionKey, true);
      const directory = join(vault, "auth");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([
        cipher.update(
          JSON.stringify({
            name: name(account),
            url,
            username: credentials.username,
            password: credentials.password,
          }),
        ),
        cipher.final(),
      ]);
      const temporary = `${profile(account)}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            encrypted: true,
            iv: iv.toString("base64"),
            authTag: cipher.getAuthTag().toString("base64"),
            data: data.toString("base64"),
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, profile(account));
      } finally {
        await rm(temporary, { force: true });
      }
    },
    forget: async (account) => {
      await rm(profile(account), { force: true });
      await rm(statePath(account), { force: true });
    },
    state,
    update: async (account, status) => {
      const previous = await state(account);
      const resolved =
        previous.handle && !status.handle ? { ...status, handle: previous.handle } : status;
      const path = statePath(account);
      await mkdir(join(home, "auth-state"), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ account, status: resolved }), {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
