import { createHash } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicFile,
  discoverDeployment,
  deploymentActive,
  readOptional,
} from "./deployment-files.ts";
import type { DeploymentCommand } from "./deployment-command.ts";

export async function ensureMacDeploymentAgent(options: {
  entry: string;
  bun: string;
  userHome: string;
  uid: number;
  run: DeploymentCommand;
}) {
  const location = await discoverDeployment(
    options.entry,
    options.userHome,
    options.bun,
    options.run,
  );
  const lock = join(location.home, "active");
  if (await deploymentActive(lock)) return;
  const code = await readFile(options.entry);
  const digest = createHash("sha256").update(code).digest("hex");
  const agent = join(location.home, "agent.js");
  const receipt = join(location.home, "bundle.sha256");
  const label = `gui/${options.uid}/im.renai.mac-deployment`;
  const installed = await options.run("/bin/launchctl", ["print", label]).then(
    () => true,
    () => false,
  );
  if ((await readOptional(receipt)) === digest && installed) return;
  if (installed) await options.run("/bin/launchctl", ["bootout", label]);
  await mkdir(join(location.home, "logs"), { recursive: true, mode: 0o700 });
  await atomicFile(agent, code);
  await atomicFile(join(location.home, "location.json"), JSON.stringify(location));
  const plist = join(options.userHome, "Library", "LaunchAgents", "im.renai.mac-deployment.plist");
  await atomicFile(
    plist,
    JSON.stringify({
      Label: "im.renai.mac-deployment",
      ProgramArguments: [
        options.bun,
        agent,
        "--mac-deployment",
        join(location.home, "location.json"),
      ],
      WorkingDirectory: location.home,
      EnvironmentVariables: {
        PATH: `${join(location.messagingHome, "deploy", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      },
      StandardOutPath: join(location.home, "logs", "stdout.log"),
      StandardErrorPath: join(location.home, "logs", "stderr.log"),
      RunAtLoad: true,
      StartInterval: 60,
      ProcessType: "Background",
    }),
  );
  await options.run("/usr/bin/plutil", ["-convert", "xml1", plist]);
  try {
    await options.run("/bin/launchctl", ["bootstrap", `gui/${options.uid}`, plist]);
    await atomicFile(receipt, digest);
  } catch (error) {
    await rm(receipt, { force: true });
    throw error;
  }
}
