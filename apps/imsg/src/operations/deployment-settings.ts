import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { exists, readPlist, type DeploymentLocation } from "./deployment-files.ts";
import { DeploymentFailure, type DeploymentCommand } from "./deployment-command.ts";

const publicKeys = [
  "SOCIAL_HOME",
  "SOCIAL_CHROME",
  "SOCIAL_PORT",
  "OPENCODE_DIRECTORY",
  "PERSONA_MODEL",
  "APPLICATION_API_URL",
  "OPENCODE_URL",
];
async function environment(
  location: DeploymentLocation,
  file: string,
  keys: readonly string[],
  run: DeploymentCommand,
  overrides: NodeJS.ProcessEnv = {},
) {
  const script = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]??""]))))`;
  return Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  )(await run(location.bun, [`--env-file=${file}`, "-e", script], { env: overrides }));
}
export async function deploymentCredentials(location: DeploymentLocation, run: DeploymentCommand) {
  const values = await environment(
    location,
    join(location.apiMsgHome, "api-msg.env"),
    ["TOKEN_MANAGEMENT", "APPLICATION_API_URL"],
    run,
  );
  if (!values["TOKEN_MANAGEMENT"]) throw new DeploymentFailure("MAC_MANAGEMENT_TOKEN_MISSING");
  return {
    token: values["TOKEN_MANAGEMENT"],
    origin: values["APPLICATION_API_URL"] || "https://api.renai.im",
  };
}
export async function socialRuntimeSettings(
  location: DeploymentLocation,
  userHome: string,
  run: DeploymentCommand,
) {
  const current = await environment(
    location,
    join(location.apiMsgHome, "api-msg.env"),
    publicKeys,
    run,
  );
  const plist = join(userHome, "Library", "LaunchAgents", "im.renai.social.plist");
  let existing: Record<string, string> = {};
  if (await exists(plist)) {
    const descriptor = await readPlist(plist, run);
    const envFile = descriptor.ProgramArguments.find((arg) => arg.startsWith("--env-file="))?.slice(
      "--env-file=".length,
    );
    const overrides = Object.fromEntries(
      publicKeys.flatMap((key) =>
        descriptor.EnvironmentVariables?.[key] ? [[key, descriptor.EnvironmentVariables[key]]] : [],
      ),
    );
    existing = envFile
      ? await environment(location, envFile, publicKeys, run, overrides)
      : overrides;
    if (!existing["SOCIAL_HOME"])
      throw new DeploymentFailure("MAC_EXISTING_PROFILE_LOCATION_UNKNOWN");
  }
  const home =
    existing["SOCIAL_HOME"] || current["SOCIAL_HOME"] || join(location.apiMsgHome, "social-state");
  if (!isAbsolute(home)) throw new DeploymentFailure("MAC_PROFILE_LOCATION_INVALID");
  const port = existing["SOCIAL_PORT"] || current["SOCIAL_PORT"] || "5407";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new DeploymentFailure("MAC_SOCIAL_PORT_INVALID");
  return {
    ...Object.fromEntries(
      publicKeys.filter((key) => current[key]).map((key) => [key, current[key]!]),
    ),
    ...Object.fromEntries(
      publicKeys.filter((key) => existing[key]).map((key) => [key, existing[key]!]),
    ),
    SOCIAL_CHROME: existing["SOCIAL_CHROME"] || current["SOCIAL_CHROME"] || "",
    SOCIAL_HOME: home,
    SOCIAL_PORT: port,
    APPLICATION_API_URL: current["APPLICATION_API_URL"] || "https://api.renai.im",
    OPENCODE_URL: current["OPENCODE_URL"] || "https://oc.renai.im",
  };
}
export function socialLaunchAgent(
  location: DeploymentLocation,
  settings: Record<string, string>,
  chrome: string,
) {
  return {
    Label: "im.renai.social",
    ProgramArguments: [
      location.bun,
      `--env-file=${join(location.apiMsgHome, "api-msg.env")}`,
      join(location.apiMsgHome, "social.js"),
    ],
    WorkingDirectory: location.apiMsgHome,
    EnvironmentVariables: {
      ...settings,
      SOCIAL_CHROME: chrome,
      SOCIAL_AGENT_BROWSER: join(location.apiMsgHome, "bin", "agent-browser"),
      PATH: `${join(location.apiMsgHome, "bin")}:/usr/bin:/bin`,
    },
    StandardOutPath: join(location.apiMsgHome, "social-logs", "stdout.log"),
    StandardErrorPath: join(location.apiMsgHome, "social-logs", "stderr.log"),
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
  };
}
