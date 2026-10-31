import { access, constants } from "node:fs/promises";
import { socialConfiguration } from "../src/config.ts";
import { browserCommands } from "../src/commands.ts";
import { xBrowser } from "../src/browser.ts";
import { socialApplication } from "../src/client.ts";
import { socialModel } from "../src/model.ts";
import { socialExecutor, socialLog } from "../src/server.ts";

const config = socialConfiguration(process.env);
const fetch = socialExecutor({
  token: config.token,
  application: socialApplication(config.application, config.token),
  model: socialModel(config.opencode),
  browser: xBrowser(browserCommands(config.home, config.chrome, config.browser)),
  readiness: async () => ({
    chromeCanary: await access(config.chrome, constants.X_OK).then(
      () => true,
      () => false,
    ),
    agentBrowser: await access(config.browser, constants.X_OK).then(
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
