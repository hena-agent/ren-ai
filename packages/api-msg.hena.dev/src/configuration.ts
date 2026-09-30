import { Config, Effect } from "effect";

export const applicationConfig = Effect.gen(function* () {
  const env = yield* Config.all({
    stateDirectory: Config.string("STATE_DIRECTORY"),
    personaDirectory: Config.string("PERSONA_DIRECTORY"),
    publicPort: Config.int("PORT").pipe(Config.withDefault(4700)),
    hostname: Config.string("LISTEN_HOST").pipe(Config.withDefault("0.0.0.0")),
    bootstrapOnly: Config.boolean("BOOTSTRAP_ONLY").pipe(Config.withDefault(false)),
    messagingUrl: Config.string("IMSG_URL"),
    messagingToken: Config.string("IMSG_TOKEN"),
    openCodeUrl: Config.string("OPENCODE_URL"),
    openCodeAuthorization: Config.string("OPENCODE_AUTHORIZATION"),
    openCodeDirectory: Config.string("OPENCODE_DIRECTORY").pipe(Config.withDefault("/srv/ren-ai")),
    model: Config.string("PERSONA_MODEL").pipe(
      Config.withDefault("opencode-go/deepseek-v4.1-flash"),
    ),
    turnstile: Config.string("TURNSTILE_SECRET"),
    applicationToken: Config.string("REN_AI_APPLICATION_TOKEN"),
    discord: Config.string("DISCORD_WEBHOOK_URL"),
  });
  return {
    stateDirectory: env.stateDirectory,
    personaDirectory: env.personaDirectory,
    publicPort: env.publicPort,
    hostname: env.hostname,
    bootstrapOnly: env.bootstrapOnly,
    messaging: { url: env.messagingUrl, token: env.messagingToken },
    opencode: {
      baseUrl: env.openCodeUrl,
      authorization: env.openCodeAuthorization,
      directory: env.openCodeDirectory,
      model: env.model,
    },
    secrets: {
      TURNSTILE_SECRET: env.turnstile,
      APPLICATION_TOKEN: env.applicationToken,
      DISCORD_WEBHOOK_URL: env.discord,
    },
  };
});
