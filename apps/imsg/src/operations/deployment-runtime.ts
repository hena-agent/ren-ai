import { dirname, join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { DeploymentLocation, atomicFile, readOptional } from "./deployment-files.ts";
import { deploymentCommand, type DeploymentCommand } from "./deployment-command.ts";
import { deploymentCredentials } from "./deployment-settings.ts";
import { deploymentControl, publicRuntimeReady } from "./deployment-control.ts";
import { deploymentArtifact } from "./deployment-artifacts.ts";
import {
  provisionMacRuntime,
  recoverMacRuntime,
  ownRuntimeDeployment,
} from "./deployment-provision.ts";
import { runDeploymentAgent } from "./deployment-agent.ts";

export async function runInstalledDeploymentAgent(
  config: string,
  revision: string,
  userHome: string,
  uid: number,
  arch: string,
  run: DeploymentCommand = deploymentCommand,
) {
  const location = Schema.decodeUnknownSync(Schema.fromJsonString(DeploymentLocation))(
    await readFile(config, "utf8"),
  );
  const credentials = await deploymentCredentials(location, run);
  const control = deploymentControl(credentials.origin, credentials.token);
  try {
    await runDeploymentAgent({
      home: location.home,
      revision,
      control,
      now: Date.now,
      healthy: publicRuntimeReady,
      own: () => ownRuntimeDeployment(uid, run),
      recover: () => recoverMacRuntime(location, userHome, uid, run),
      apply: async (target, progress) => {
        const bundle = await deploymentArtifact(location, target, run);
        try {
          await provisionMacRuntime({
            location,
            bundle,
            revision: target,
            userHome,
            uid,
            arch,
            run,
            progress,
          });
        } finally {
          await rm(dirname(bundle), { recursive: true, force: true });
        }
      },
      log: (event) =>
        (event.outcome === "failed" ? process.stderr : process.stdout).write(
          `${JSON.stringify({ service: "mac-deployment", requestId: event.operationId, operation: "runtime.repair", ...event })}\n`,
        ),
    });
  } finally {
    // A new attested messaging bundle updates the agent snapshot without restarting an active repair.
    const entry = join(location.messagingHome, "imsg.js");
    const installedRevision = (
      await readOptional(join(location.messagingHome, "artifact.info"))
    )?.match(/^revision=([a-f0-9]{40})$/m)?.[1];
    if (installedRevision && installedRevision !== revision)
      await atomicFile(join(location.home, "agent.js"), await readFile(entry));
  }
}
