import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { parseHealth } from "@ren-ai/transport/health";
import { join } from "node:path";
import type { MacDeploymentStatus } from "@ren-ai/transport/deployment";
import { atomicFile, exists, type DeploymentLocation } from "./deployment-files.ts";
import { DeploymentFailure, type DeploymentCommand } from "./deployment-command.ts";
import { installBrowserCli, installCanary } from "./deployment-browser.ts";
import { socialLaunchAgent, socialRuntimeSettings } from "./deployment-settings.ts";

const payload = ["api-msg", "api-msg-verify", "social"]
  .flatMap((name) => [`${name}.js`, `${name}.graph.json`])
  .concat("artifact.info");
const files = [
  ...payload,
  "SHA256SUMS",
  "mac-runtime.compose.yml",
  "Dockerfile.mac-runtime",
  "Dockerfile.mac-runtime.dockerignore",
];
const Transaction = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(Schema.Literals(files)),
    hadPlist: Schema.Boolean,
    revision: Schema.String,
    applying: Schema.Boolean,
  }),
);
const RuntimeHealth = Schema.fromJsonString(
  Schema.Struct({
    service: Schema.String,
    revision: Schema.String,
    status: Schema.String,
    social: Schema.Struct({ status: Schema.Literal("ready") }),
  }),
);
type Progress = (state: MacDeploymentStatus["state"], stage: string) => Promise<void>;
export async function ownRuntimeDeployment(uid: number, run: DeploymentCommand) {
  const label = `gui/${uid}/im.renai.api-msg-deploy`;
  const registered = await run("/bin/launchctl", ["print", label]).catch(() => "");
  if (!registered) return;
  await run("/bin/launchctl", ["disable", label]);
  if (/^\s*pid = \d+/m.test(registered)) throw new DeploymentFailure("MAC_LEGACY_UPDATER_BUSY");
}
const compose = (location: DeploymentLocation) => [
  "compose",
  "-f",
  join(location.apiMsgHome, "compose.yml"),
  "-f",
  join(location.apiMsgHome, "mac-runtime.compose.yml"),
];
async function gateway(location: DeploymentLocation, run: DeploymentCommand) {
  const args = (await exists(join(location.apiMsgHome, "mac-runtime.compose.yml")))
    ? compose(location)
    : ["compose", "-f", join(location.apiMsgHome, "compose.yml")];
  await run(location.docker, [...args, "build", "api-msg"], { timeout: 300000 });
  await run(
    location.docker,
    [...args, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "api-msg"],
    { timeout: 180000 },
  );
  await run(location.docker, [...args, "exec", "-T", "api-msg", "bun", "/app/api-msg-verify.js"]);
}
async function localReady(location: DeploymentLocation, run: DeploymentCommand, revision: string) {
  if (!(await exists(join(location.apiMsgHome, "mac-runtime.compose.yml")))) return false;
  try {
    const raw = await run(location.docker, [
      ...compose(location),
      "exec",
      "-T",
      "api-msg",
      "bun",
      "-e",
      'process.stdout.write(await (await fetch("http://127.0.0.1:4700/health")).text())',
    ]);
    const body = Schema.decodeUnknownSync(RuntimeHealth)(raw);
    return parseHealth(body, "api-msg", revision).status === "ready";
  } catch {
    return false;
  }
}
async function recover(
  location: DeploymentLocation,
  plist: string,
  label: string,
  uid: number,
  run: DeploymentCommand,
) {
  const backup = join(location.home, "previous");
  const marker = join(backup, "transaction.json");
  if (!(await exists(marker))) return;
  const saved = Schema.decodeUnknownSync(Transaction)(await readFile(marker, "utf8"));
  if (saved.applying && !(await localReady(location, run, saved.revision))) {
    for (const name of files) {
      if (saved.files.includes(name))
        await atomicFile(join(location.apiMsgHome, name), await readFile(join(backup, name)));
      else await rm(join(location.apiMsgHome, name), { force: true });
    }
    await run("/bin/launchctl", ["bootout", label]).catch(() => {});
    if (saved.hadPlist) {
      await atomicFile(plist, await readFile(join(backup, "social.plist")));
      await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist]);
    } else await rm(plist, { force: true });
    await gateway(location, run);
  }
  await rm(marker);
}
export const recoverMacRuntime = (
  location: DeploymentLocation,
  userHome: string,
  uid: number,
  run: DeploymentCommand,
) =>
  recover(
    location,
    join(userHome, "Library", "LaunchAgents", "im.renai.social.plist"),
    `gui/${uid}/im.renai.social`,
    uid,
    run,
  );
export async function provisionMacRuntime(options: {
  location: DeploymentLocation;
  bundle: string;
  revision: string;
  userHome: string;
  uid: number;
  arch: string;
  run: DeploymentCommand;
  progress: Progress;
}) {
  const { location, bundle, run, progress } = options;
  const plist = join(options.userHome, "Library", "LaunchAgents", "im.renai.social.plist");
  const label = `gui/${options.uid}/im.renai.social`;
  await recover(location, plist, label, options.uid, run);
  const settings = await socialRuntimeSettings(location, options.userHome, run);
  const oldPlist = (await exists(plist)) ? await readFile(plist) : undefined;
  await progress("installing", "browser_cli");
  await installBrowserCli(location, options.arch, run);
  await progress("installing", "canary");
  const chrome = await installCanary(location, options.userHome, settings["SOCIAL_CHROME"], run);
  const backup = join(location.home, "previous");
  await rm(backup, { recursive: true, force: true });
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const saved: string[] = [];
  for (const name of files)
    if (await exists(join(location.apiMsgHome, name))) {
      await copyFile(join(location.apiMsgHome, name), join(backup, name));
      saved.push(name);
    }
  if (oldPlist) await atomicFile(join(backup, "social.plist"), oldPlist);
  const transaction = {
    files: saved,
    hadPlist: Boolean(oldPlist),
    revision: options.revision,
    applying: false,
  };
  await atomicFile(join(backup, "transaction.json"), JSON.stringify(transaction));
  try {
    await progress("installing", "runtime_files");
    await atomicFile(
      join(backup, "transaction.json"),
      JSON.stringify({ ...transaction, applying: true }),
    );
    for (const name of payload)
      await atomicFile(join(location.apiMsgHome, name), await readFile(join(bundle, name)));
    await atomicFile(
      join(location.apiMsgHome, "Dockerfile.mac-runtime"),
      await readFile(join(bundle, "Dockerfile")),
    );
    await atomicFile(
      join(location.apiMsgHome, "Dockerfile.mac-runtime.dockerignore"),
      await readFile(join(bundle, "Dockerfile.dockerignore")),
    );
    await atomicFile(
      join(location.apiMsgHome, "mac-runtime.compose.yml"),
      JSON.stringify({
        services: {
          "api-msg": {
            build: { context: location.apiMsgHome, dockerfile: "Dockerfile.mac-runtime" },
            environment: { SOCIAL_URL: `http://host.docker.internal:${settings.SOCIAL_PORT}` },
          },
        },
      }),
    );
    const hashes = await Promise.all(
      files
        .filter((name) => name !== "SHA256SUMS")
        .map(
          async (name) =>
            `${createHash("sha256")
              .update(await readFile(join(location.apiMsgHome, name)))
              .digest("hex")}  ${name}`,
        ),
    );
    await atomicFile(join(location.apiMsgHome, "SHA256SUMS"), hashes.join("\n") + "\n");
    await mkdir(join(location.apiMsgHome, "social-logs"), { recursive: true, mode: 0o700 });
    await mkdir(settings.SOCIAL_HOME, { recursive: true, mode: 0o700 });
    await run("/bin/launchctl", ["bootout", label]).catch(() => {});
    await atomicFile(plist, JSON.stringify(socialLaunchAgent(location, settings, chrome)));
    await run("/usr/bin/plutil", ["-convert", "xml1", plist]);
    await progress("starting", "social_service");
    await run("/bin/launchctl", ["enable", label]);
    await run("/bin/launchctl", ["bootstrap", `gui/${options.uid}`, plist]);
    await progress("starting", "gateway");
    await gateway(location, run);
    await rm(join(backup, "transaction.json"));
  } catch (cause) {
    await recover(location, plist, label, options.uid, run);
    throw cause;
  }
}
