/** @param {string} name */
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const { createGateway } = await import("../src/index.ts");
const handler = createGateway({
  config: {
    executorToken: required("TOKEN_EXECUTOR"),
    opencodeUrl: process.env.OPENCODE_URL ?? "https://oc.renai.im",
    opencodeAuthorization: required("OPENCODE_AUTHORIZATION"),
    imsgUrl: process.env.IMSG_URL ?? "https://imsg.renai.im/rpc",
    imsgToken: required("IMSG_TOKEN"),
  },
});
Bun.serve({
  hostname: process.env.LISTEN_HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 4700),
  fetch: handler,
});
