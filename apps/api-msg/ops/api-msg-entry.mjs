/** @param {string} name */
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const { createGateway, runApplicationWatch } = await import("../src/index.ts");
const { Effect } = await import("effect");
const handler = createGateway({
  config: {
    managementToken: required("TOKEN_MANAGEMENT"),
    opencodeUrl: process.env.OPENCODE_URL ?? "https://oc.renai.im",
    opencodeAuthorization: required("OPENCODE_AUTHORIZATION"),
    imsgUrl: process.env.IMSG_URL ?? "https://imsg.renai.im/rpc",
    imsgToken: required("IMSG_TOKEN"),
  },
});
const server = Bun.serve({
  hostname: process.env.LISTEN_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4700),
  fetch: handler,
});
Effect.runFork(
  runApplicationWatch(
    process.env.APPLICATION_API_URL ?? "https://api.renai.im",
    required("TOKEN_MANAGEMENT"),
    process.env.IMSG_URL ?? "https://imsg.renai.im/rpc",
    required("IMSG_TOKEN"),
  ),
);
process.stdout.write(
  `${JSON.stringify({ service: "api-msg", event: "listening", url: server.url.href })}\n`,
);
