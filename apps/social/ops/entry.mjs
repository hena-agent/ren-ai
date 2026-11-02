import { access, constants } from "node:fs/promises";
import { socialConfiguration } from "../src/config.ts";
import { browserCommands, requireAuthenticationVersion } from "../src/commands.ts";
import { socialBrowser } from "../src/browser.ts";
import { socialApplication } from "../src/client.ts";
import { socialModel } from "../src/model.ts";
import { socialExecutor } from "../src/server.ts";
import { socialLog } from "../src/logging.ts";
import { accountQueue } from "../src/account-queue.ts";
import { authStore } from "../src/auth-store.ts";
import { socialAuthentication } from "../src/authentication.ts";

const config = socialConfiguration(process.env);
const commands = browserCommands(config.home, config.chrome, config.browser);
const exclusive = accountQueue();
const application = socialApplication(config.application, config.token);
const authentication = socialAuthentication({
  commands,
  exclusive,
  store: authStore(config.home),
  authenticated: application.authenticated,
  failure: (event) =>
    socialLog({
      requestId: event.requestId,
      personaId: event.account.personaId,
      operation: "social.auth",
      stage: event.stage,
      outcome: "failed",
      durationMs: event.durationMs,
      level: event.diagnostic ? "error" : "warn",
      code: `SOCIAL_AUTH_${event.code.toUpperCase()}`,
      ...event.diagnostic,
    }),
});
const fetch = socialExecutor({
  token: config.token,
  application,
  model: socialModel(config.opencode),
  browser: socialBrowser(commands, authentication, exclusive),
  authentication,
  readiness: async () => ({
    chromeCanary: await access(config.chrome, constants.X_OK).then(
      () => true,
      () => false,
    ),
    agentBrowser: await requireAuthenticationVersion(
      commands,
      "health",
      0,
      AbortSignal.timeout(5000),
    ).then(
      () => true,
      () => false,
    ),
    openCode: await globalThis
      .fetch(new URL("/api/info", config.opencode.url), {
        headers: { Authorization: config.opencode.authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      })
      .then(
        (response) => response.ok,
        () => false,
      ),
  }),
});
const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, idleTimeout: 120, fetch });
socialLog({
  requestId: crypto.randomUUID(),
  operation: "social.start",
  stage: "listener",
  outcome: "started",
  durationMs: 0,
  level: "info",
  port: server.port,
});
