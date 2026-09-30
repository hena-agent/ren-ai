import { ConfigProvider, Effect } from "effect";
import { expect, test } from "vitest";
import { applicationConfig } from "./configuration.ts";

const required = {
  STATE_DIRECTORY: "/state",
  PERSONA_DIRECTORY: "/personas",
  IMSG_URL: "https://imsg.hena.dev/rpc",
  IMSG_TOKEN: "messaging",
  OPENCODE_URL: "https://oc.hena.dev",
  OPENCODE_AUTHORIZATION: "Basic opencode",
  TURNSTILE_SECRET: "turnstile",
  REN_AI_APPLICATION_TOKEN: "application",
  DISCORD_WEBHOOK_URL: "https://discord.test/hook",
};

test("deployment defaults select the persona location and normal Docker listener", async () => {
  const config = await Effect.runPromise(
    applicationConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(required))),
    ),
  );
  expect(config).toEqual({
    stateDirectory: "/state",
    personaDirectory: "/personas",
    publicPort: 4700,
    hostname: "0.0.0.0",
    bootstrapOnly: false,
    messaging: { url: "https://imsg.hena.dev/rpc", token: "messaging" },
    opencode: {
      baseUrl: "https://oc.hena.dev",
      authorization: "Basic opencode",
      directory: "/srv/ren-ai",
      model: "opencode-go/deepseek-v4.1-flash",
    },
    secrets: {
      TURNSTILE_SECRET: "turnstile",
      APPLICATION_TOKEN: "application",
      DISCORD_WEBHOOK_URL: "https://discord.test/hook",
    },
  });
});

test("a replacement deployment can override binding, location, model and bootstrap mode", async () => {
  const config = await Effect.runPromise(
    applicationConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...required,
            PORT: "8740",
            LISTEN_HOST: "127.0.0.1",
            BOOTSTRAP_ONLY: "true",
            OPENCODE_DIRECTORY: "/replacement/personas",
            PERSONA_MODEL: "provider/replacement",
          }),
        ),
      ),
    ),
  );
  expect(config.publicPort).toBe(8740);
  expect(config.hostname).toBe("127.0.0.1");
  expect(config.bootstrapOnly).toBe(true);
  expect(config.opencode.directory).toBe("/replacement/personas");
  expect(config.opencode.model).toBe("provider/replacement");
});
