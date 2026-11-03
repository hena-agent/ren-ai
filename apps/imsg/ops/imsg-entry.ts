import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Logger } from "effect";
import { startMessagingGateway } from "../src/gateway/runtime.ts";
import { homedir } from "node:os";
import { buildRevision } from "@ren-ai/transport/health";
import { ensureMacDeploymentAgent } from "../src/operations/deployment-bootstrap.ts";
import { deploymentCommand, DeploymentFailure } from "../src/operations/deployment-command.ts";
import { runInstalledDeploymentAgent } from "../src/operations/deployment-runtime.ts";

process.umask(0o077);

if (process.argv[2] === "--mac-deployment") {
  try {
    await runInstalledDeploymentAgent(
      process.argv[3]!,
      buildRevision(),
      homedir(),
      process.getuid!(),
      process.arch,
    );
  } catch (cause) {
    process.stderr.write(
      `${JSON.stringify({ service: "mac-deployment", operation: "runtime.repair", stage: "agent", outcome: "failed", code: cause instanceof DeploymentFailure ? cause.code : "MAC_AGENT_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
} else {
  const enrolledGateway = Effect.sync(() => {
    if (process.platform === "darwin" && buildRevision() !== "development") {
      void ensureMacDeploymentAgent({
        entry: process.argv[1]!,
        bun: process.execPath,
        userHome: homedir(),
        uid: process.getuid!(),
        run: deploymentCommand,
      }).catch((cause) => {
        process.stderr.write(
          `${JSON.stringify({ service: "mac-deployment", operation: "agent.bootstrap", stage: "bootstrap", outcome: "failed", code: cause instanceof DeploymentFailure ? cause.code : "MAC_BOOTSTRAP_FAILED" })}\n`,
        );
      });
    }
  }).pipe(Effect.andThen(startMessagingGateway));
  NodeRuntime.runMain(
    Effect.scoped(enrolledGateway.pipe(Effect.andThen(Effect.never))).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        Logger.layer([
          Logger.make((entry) => {
            const stream =
              entry.logLevel === "Warn" || entry.logLevel === "Error" || entry.logLevel === "Fatal"
                ? process.stderr
                : process.stdout;
            stream.write(`${Logger.formatJson.log(entry)}\n`);
          }),
        ]),
      ),
    ),
  );
}
