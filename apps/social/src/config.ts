import { isAbsolute } from "node:path";

export function socialConfiguration(env: NodeJS.ProcessEnv) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const origin = (name: string) => {
    const url = new URL(required(name));
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    )
      throw new Error(`${name} must be a credential-free HTTPS or loopback origin`);
    return url.href;
  };
  const home = required("SOCIAL_HOME");
  if (!isAbsolute(home)) throw new Error("SOCIAL_HOME must be absolute");
  const port = Number(env["SOCIAL_PORT"] ?? 5407);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid SOCIAL_PORT");
  return {
    token: required("TOKEN_MANAGEMENT"),
    application: origin("APPLICATION_API_URL"),
    home,
    port,
    chrome:
      env["SOCIAL_CHROME"] ??
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    browser: env["SOCIAL_AGENT_BROWSER"] ?? "/opt/homebrew/bin/agent-browser",
    opencode: {
      url: origin("OPENCODE_URL"),
      authorization: required("OPENCODE_AUTHORIZATION"),
      directory: env["OPENCODE_DIRECTORY"] ?? "/srv/ren-ai",
      model: env["PERSONA_MODEL"] ?? "opencode-go/deepseek-v4.1-flash",
    },
  };
}
