import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { Schema } from "effect";
import type { DeploymentCommand } from "./deployment-command.ts";
import { DeploymentFailure } from "./deployment-command.ts";

export const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
export async function atomicFile(path: string, contents: string | Uint8Array, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(next, contents, { mode });
    await chmod(next, mode);
    await rename(next, path);
  } finally {
    await rm(next, { force: true });
  }
}
const absolute = Schema.String.check(Schema.makeFilter(isAbsolute));
export const DeploymentLocation = Schema.Struct({
  messagingHome: absolute,
  apiMsgHome: absolute,
  home: absolute,
  bun: absolute,
  docker: absolute,
});
export type DeploymentLocation = typeof DeploymentLocation.Type;
const Plist = Schema.Struct({
  ProgramArguments: Schema.Array(Schema.String),
  EnvironmentVariables: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export async function readPlist(path: string, run: DeploymentCommand) {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Plist))(
    await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]),
  );
}
export async function discoverDeployment(
  entry: string,
  userHome: string,
  bun: string,
  run: DeploymentCommand,
): Promise<DeploymentLocation> {
  const messagingHome = dirname(entry);
  if (!isAbsolute(entry) || !(await exists(join(messagingHome, "deploy", "token"))))
    throw new DeploymentFailure("MAC_DEPLOY_CREDENTIALS_MISSING");
  let apiMsgHome = join(userHome, "Library", "Application Support", "ren-ai-api-msg");
  let configuredPath = "";
  const plist = join(userHome, "Library", "LaunchAgents", "im.renai.api-msg-deploy.plist");
  if (await exists(plist)) {
    const descriptor = await readPlist(plist, run);
    const candidate = descriptor.ProgramArguments.at(-1);
    if (!candidate || !isAbsolute(candidate))
      throw new DeploymentFailure("MAC_DEPLOY_LOCATION_INVALID");
    apiMsgHome = candidate;
    configuredPath = descriptor.EnvironmentVariables?.["PATH"] ?? "";
  }
  if (!(await exists(join(apiMsgHome, "api-msg.env"))))
    throw new DeploymentFailure("MAC_API_CONFIG_MISSING");
  const docker = [
    ...configuredPath
      .split(":")
      .filter(isAbsolute)
      .map((path) => join(path, "docker")),
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    join(userHome, ".docker", "bin", "docker"),
  ];
  const available = await Promise.all(docker.map(exists));
  const selected = docker.find((_path, index) => available[index]);
  if (!selected) throw new DeploymentFailure("MAC_DOCKER_MISSING");
  return {
    messagingHome,
    apiMsgHome,
    home: join(userHome, "Library", "Application Support", "ren-ai-mac-deployment"),
    bun,
    docker: selected,
  };
}
export const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);
export async function deploymentActive(lock: string) {
  const pid = Number(await readOptional(join(lock, "pid")));
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
    }
  }
  const info = await stat(lock).catch(() => undefined);
  return Boolean(info && Date.now() - info.mtimeMs < 60000);
}
