import type {
  SocialAuthAccount,
  SocialAuthCommand,
  SocialAuthStatus,
} from "@ren-ai/onboarding/social-auth";
import type { AccountQueue } from "./account-queue.ts";
import { requireAuthenticationVersion, type BrowserCommands } from "./commands.ts";
import { AuthenticationError, AuthenticationConflict, type AuthStore } from "./auth-store.ts";
import { loginPage } from "./login-page.ts";
import { socialDiagnostic } from "./logging.ts";

export interface SocialAuthentication {
  status: (account: SocialAuthAccount) => Promise<SocialAuthStatus>;
  submit: (
    account: SocialAuthAccount,
    command: SocialAuthCommand,
    requestId: string,
  ) => Promise<SocialAuthStatus>;
  ensure: (account: SocialAuthAccount, port: number, signal: AbortSignal) => Promise<void>;
}
type AuthFailure = {
  diagnostic?: ReturnType<typeof socialDiagnostic>;
  requestId: string;
  account: SocialAuthAccount;
  stage: string;
  code: string;
  durationMs: number;
};
type LoginScreen = Awaited<ReturnType<ReturnType<typeof loginPage>["screen"]>>;
function screenOutcome(
  screen: LoginScreen,
  account: SocialAuthAccount,
  hasCredentials: boolean,
  code?: string,
): SocialAuthStatus | undefined {
  if (screen.origin !== "https://x.com")
    throw new AuthenticationError({ state: "failed", hasCredentials, reason: "unavailable" });
  if (screen.stage === "authenticated")
    return screen.handle?.toLowerCase() === account.handle.toLowerCase()
      ? { state: "authenticated", hasCredentials }
      : { state: "failed", hasCredentials, reason: "account_mismatch" };
  if (screen.stage === "manual") return { state: "manual_required", hasCredentials };
  if (screen.stage === "rejected")
    return { state: "failed", hasCredentials, reason: "credentials_rejected" };
  if (code !== undefined && screen.stage !== "code")
    return { state: "manual_required", hasCredentials, reason: "interrupted" };
  if (screen.stage === "code" && code === undefined)
    return { state: "code_required", hasCredentials };
  return undefined;
}
async function loginValue(
  stage: LoginScreen["stage"],
  store: AuthStore,
  account: SocialAuthAccount,
  code?: string,
) {
  if (stage === "code") return code!;
  if (stage === "identity") return account.handle;
  return (await store.load(account))[stage === "password" ? "password" : "username"];
}

async function login(
  commands: BrowserCommands,
  store: AuthStore,
  account: SocialAuthAccount,
  port: number,
  signal: AbortSignal,
  code?: string,
): Promise<SocialAuthStatus> {
  const page = loginPage(commands, account.id, port, signal);
  await requireAuthenticationVersion(commands, account.id, port, signal);
  if (code === undefined) await page.open();
  const hasCredentials = await store.has(account);
  const submitted = new Set<string>();
  for (let step = 0; step < 24; step++) {
    const screen = await page.screen();
    const outcome = screenOutcome(screen, account, hasCredentials, code);
    if (outcome) return outcome;
    if (screen.submit && !submitted.has(screen.stage) && screen.stage !== "loading") {
      const value = await loginValue(screen.stage, store, account, code);
      await page.enter(value);
      submitted.add(screen.stage);
    }
    await page.wait();
  }
  return { state: "manual_required", hasCredentials };
}

export function socialAuthentication(options: {
  commands: BrowserCommands;
  store: AuthStore;
  exclusive: AccountQueue;
  authenticated: (account: SocialAuthAccount) => Promise<void>;
  failure: (event: AuthFailure) => void;
}): SocialAuthentication {
  const jobs = new Set<string>();
  const status = async (account: SocialAuthAccount): Promise<SocialAuthStatus> => {
    const current = await options.store.state(account);
    if (jobs.has(account.id) && current.state !== "authenticated")
      return { ...current, state: "logging_in" };
    return current.state === "logging_in" && !jobs.has(account.id)
      ? { ...current, state: "login_required", reason: "interrupted" }
      : current;
  };
  const attempt = async (
    account: SocialAuthAccount,
    port: number,
    signal: AbortSignal,
    requestId: string,
    code?: string,
  ) => {
    const started = performance.now();
    let result: SocialAuthStatus;
    let diagnostic: ReturnType<typeof socialDiagnostic> | undefined;
    try {
      result = await login(options.commands, options.store, account, port, signal, code);
    } catch (cause) {
      diagnostic = socialDiagnostic(cause);
      result = {
        state: "failed",
        hasCredentials: await options.store.has(account),
        reason: "unavailable",
      };
    }
    await options.store.update(account, result);
    if (result.state === "authenticated") {
      void options.authenticated(account).catch((cause) =>
        options.failure({
          account,
          requestId,
          stage: "login.callback",
          diagnostic: socialDiagnostic(cause),
          code: "unavailable",
          durationMs: performance.now() - started,
        }),
      );
    } else
      options.failure({
        account,
        requestId,
        stage: "login.execute",
        ...(diagnostic && { diagnostic }),
        code: result.reason ?? result.state,
        durationMs: performance.now() - started,
      });
    return result;
  };
  return {
    status,
    submit: async (account, command, requestId) => {
      if (command.kind === "status") return status(account);
      if (jobs.has(account.id))
        throw new AuthenticationConflict("Authentication already in progress");
      const started = performance.now();
      jobs.add(account.id);
      try {
        if (command.kind === "forget") {
          await options.exclusive(account.id, () => options.store.forget(account));
          jobs.delete(account.id);
          return { state: "not_configured", hasCredentials: false };
        }
        const current = await options.store.state(account);
        if (command.kind === "code" && current.state !== "code_required")
          throw new AuthenticationConflict("No verification code is expected");
        await options.store.update(account, {
          state: "logging_in",
          hasCredentials: current.hasCredentials,
        });
        const job = options
          .exclusive(account.id, async () => {
            const signal = AbortSignal.timeout(90000);
            const port = await options.commands.open(account.id);
            if (command.kind === "save")
              await options.store.save(
                account,
                { username: command.username, password: command.password },
                port,
                signal,
              );
            await attempt(
              account,
              port,
              signal,
              requestId,
              command.kind === "code" ? command.code : undefined,
            );
          })
          .catch(async (cause) => {
            options.failure({
              account,
              requestId,
              stage: "login.prepare",
              diagnostic: socialDiagnostic(cause),
              code: "unavailable",
              durationMs: performance.now() - started,
            });
            await options.store.update(account, {
              state: "failed",
              hasCredentials: await options.store.has(account),
              reason: "unavailable",
            });
          })
          .finally(() => {
            jobs.delete(account.id);
          });
        void job.catch((cause) =>
          options.failure({
            account,
            requestId,
            stage: "login.persistence",
            diagnostic: socialDiagnostic(cause),
            code: "unavailable",
            durationMs: performance.now() - started,
          }),
        );
        return { state: "logging_in", hasCredentials: current.hasCredentials };
      } catch (cause) {
        jobs.delete(account.id);
        throw cause;
      }
    },
    ensure: async (account, port, signal) => {
      const current = await status(account);
      if (!current.hasCredentials) {
        const required: SocialAuthStatus = { state: "not_configured", hasCredentials: false };
        await options.store.update(account, required);
        throw new AuthenticationError(required);
      }
      if (
        current.reason === "interrupted" ||
        ["failed", "code_required", "manual_required", "logging_in"].includes(current.state)
      )
        throw new AuthenticationError(current);
      jobs.add(account.id);
      try {
        await options.store.update(account, { state: "logging_in", hasCredentials: true });
        const result = await attempt(account, port, signal, crypto.randomUUID());
        if (result.state !== "authenticated") throw new AuthenticationError(result);
      } finally {
        jobs.delete(account.id);
      }
    },
  };
}
