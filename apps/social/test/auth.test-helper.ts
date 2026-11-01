import type { SocialAuthStatus } from "@ren-ai/onboarding/social-auth";
import { socialAuthAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { accountQueue } from "../src/account-queue.ts";
import { socialAuthentication } from "../src/authentication.ts";
import type { AuthStore } from "../src/auth-store.ts";
import type { BrowserCommands } from "../src/commands.ts";

export const privateLogin = {
  username: "private.login@example.test",
  password: "PRIVATE_PASSWORD_!",
  code: "123456",
};
export function authFixture() {
  const account = socialAuthAccount;
  let state: SocialAuthStatus = { state: "login_required", hasCredentials: true };
  let credentials = true;
  const sequence = ["username", "password", "authenticated"];
  let index = 0;
  let handle = account.handle;
  let origin = "https://x.com";
  let advance = true;
  let submit = true;
  const commandArgs: string[][] = [];
  const inputs: string[] = [];
  const notifications: string[] = [];
  const failures: string[] = [];
  const failureEvents: Parameters<Parameters<typeof socialAuthentication>[0]["failure"]>[0][] = [];
  const store: AuthStore = {
    has: async () => credentials,
    load: async () => ({ username: privateLogin.username, password: privateLogin.password }),
    save: async () => {
      credentials = true;
    },
    forget: async () => {
      credentials = false;
      state = { state: "not_configured", hasCredentials: false };
    },
    state: async () => ({ ...state, hasCredentials: credentials }),
    update: async (_account, value) => {
      state = value;
    },
  };
  const commands: BrowserCommands = {
    open: async () => 1234,
    command: async (_account, _port, args, _signal, input) => {
      commandArgs.push([...args]);
      if (args[0] === "--version") return "agent-browser 0.41.0";
      if (input !== undefined) {
        inputs.push(input);
        return '[{"success":true,"data":{"value":"PRIVATE_ECHO"}}]';
      }
      if (args[0] === "click" && advance) index++;
      if (args[0] === "eval")
        return JSON.stringify({
          success: true,
          data: {
            result: JSON.stringify({
              stage: sequence[Math.min(index, sequence.length - 1)],
              handle: sequence[index] === "authenticated" ? handle : null,
              origin,
              path: "/i/flow/login",
              submit,
            }),
          },
        });
      return '{"success":true}';
    },
  };
  const options: Parameters<typeof socialAuthentication>[0] = {
    commands,
    store,
    exclusive: accountQueue(),
    authenticated: async () => {
      notifications.push("authenticated");
    },
    failure: (event) => {
      failures.push(event.code);
      failureEvents.push(event);
    },
  };
  const auth = socialAuthentication(options);
  return {
    account,
    auth,
    options,
    store,
    commands,
    commandArgs,
    inputs,
    notifications,
    failures,
    failureEvents,
    setState: (next: SocialAuthStatus) => {
      state = next;
    },
    setCredentials: (value: boolean) => {
      credentials = value;
    },
    screens: (...screens: string[]) => {
      sequence.splice(0, sequence.length, ...screens);
      index = 0;
    },
    setHandle: (value: string) => {
      handle = value;
    },
    setOrigin: (value: string) => {
      origin = value;
    },
    setAdvance: (value: boolean) => {
      advance = value;
    },
    setSubmit: (value: boolean) => {
      submit = value;
    },
  };
}
