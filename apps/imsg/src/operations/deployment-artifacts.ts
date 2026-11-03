import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import type { DeploymentLocation } from "./deployment-files.ts";
import { DeploymentFailure, type DeploymentCommand } from "./deployment-command.ts";

const Runs = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      databaseId: Schema.Number,
      headSha: Schema.String,
      status: Schema.String,
      conclusion: Schema.String,
    }),
  ),
);
export async function deploymentArtifact(
  location: DeploymentLocation,
  revision: string,
  run: DeploymentCommand,
) {
  const token = (await readFile(join(location.messagingHome, "deploy", "token"), "utf8")).trim();
  const gh = join(location.messagingHome, "deploy", "bin", "gh");
  const env = {
    GH_TOKEN: token,
    GH_CONFIG_DIR: join(location.messagingHome, "deploy", "gh"),
    GH_PROMPT_DISABLED: "1",
  };
  const records = Schema.decodeUnknownSync(Runs)(
    await run(
      gh,
      [
        "run",
        "list",
        "-R",
        "hena-agent/ren-ai",
        "-w",
        "ci.yml",
        "-b",
        "main",
        "-e",
        "push",
        "--commit",
        revision,
        "-L",
        "1",
        "--json",
        "databaseId,headSha,status,conclusion",
      ],
      { env },
    ),
  );
  const record = records[0];
  if (!record || record.headSha !== revision) throw new DeploymentFailure("MAC_ARTIFACT_NOT_READY");
  const artifact = await run(
    gh,
    [
      "api",
      `repos/hena-agent/ren-ai/actions/runs/${record.databaseId}/artifacts`,
      "--jq",
      '[.artifacts[] | select(.name == "api-msg-bundle" and (.expired | not))][0].id // empty',
    ],
    { env },
  );
  if (!/^\d+\s*$/.test(artifact)) throw new DeploymentFailure("MAC_ARTIFACT_NOT_READY");
  const directory = join(location.home, "download");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await run(
      gh,
      [
        "run",
        "download",
        String(record.databaseId),
        "-R",
        "hena-agent/ren-ai",
        "-n",
        "api-msg-bundle",
        "-D",
        directory,
      ],
      { env },
    );
    const archive = join(directory, "api-msg-bundle.tar.gz");
    await run(
      gh,
      [
        "attestation",
        "verify",
        archive,
        "-R",
        "hena-agent/ren-ai",
        "--signer-workflow",
        "github.com/hena-agent/ren-ai/.github/workflows/ci.yml",
        "--source-ref",
        "refs/heads/main",
        "--source-digest",
        revision,
        "--deny-self-hosted-runners",
      ],
      { env },
    );
    const bundle = join(directory, "bundle");
    await mkdir(bundle, { recursive: true, mode: 0o700 });
    await run("/usr/bin/tar", ["-xzf", archive, "-C", bundle]);
    await run("/bin/bash", [join(bundle, "verify-artifact.sh"), bundle]);
    return bundle;
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}
