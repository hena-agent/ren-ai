import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Schema } from "effect";
import { DeploymentReport } from "@ren-ai/transport/deployment";
import { atomicFile, exists, readOptional } from "./deployment-files.ts";
import { runInstalledDeploymentAgent } from "./deployment-runtime.ts";
import * as artifacts from "./deployment-artifacts.ts";
import * as provisioning from "./deployment-provision.ts";
import { DeploymentFailure } from "./deployment-command.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

afterEach(() => vi.unstubAllGlobals());
const fixture = deploymentTestContext();
const revision = "a".repeat(40);
test.each(["ready", "failed", "same_agent", "no_revision"])(
  "installed entry runs durable control, cleans downloads and safely refreshes its snapshot: %s",
  async (outcome) => {
    const { root, location, run } = await fixture();
    const config = join(location.home, "location.json");
    await atomicFile(config, JSON.stringify(location));
    await atomicFile(join(location.messagingHome, "imsg.js"), "next attested code");
    if (outcome !== "no_revision")
      await atomicFile(
        join(location.messagingHome, "artifact.info"),
        `revision=${outcome === "same_agent" ? revision : "b".repeat(40)}\n`,
      );
    const bundle = join(location.home, "download/bundle");
    await atomicFile(join(bundle, "artifact.info"), "trusted");
    vi.spyOn(artifacts, "deploymentArtifact").mockResolvedValue(bundle);
    vi.spyOn(provisioning, "recoverMacRuntime").mockResolvedValue();
    let ready = false;
    vi.spyOn(provisioning, "provisionMacRuntime").mockImplementation(async (options) => {
      await options.progress("starting", "gateway");
      if (outcome === "failed")
        throw new DeploymentFailure("MAC_COMMAND_FAILED", 7, "MAC_SUBPROCESS_FAILED");
      ready = true;
    });
    const job = { id: "job", revision, state: "queued", stage: "waiting_agent", updatedAt: 1 };
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const incoming = new Request(input, options);
      const url = incoming.url;
      if (url.endsWith("/health"))
        return Response.json({
          service: "api-msg",
          revision,
          status: ready ? "ready" : "degraded",
          social: { status: ready ? "ready" : "degraded" },
        });
      if (url.endsWith("/claim")) return Response.json({ status: job, lease: "lease" });
      if (url.endsWith("/report"))
        return Response.json(
          Schema.decodeUnknownSync(Schema.fromJsonString(DeploymentReport))(await incoming.text())
            .status,
        );
      return Response.json({
        desiredRevision: revision,
        gatewayUrl: "https://gateway.test",
        status: job,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    run.mockImplementation(async (_program, args) =>
      args[0]?.startsWith("--env-file=")
        ? JSON.stringify({
            TOKEN_MANAGEMENT: "private-token",
            APPLICATION_API_URL: "https://api.test",
          })
        : "",
    );
    const logs: string[] = [];
    for (const stream of [process.stdout, process.stderr])
      vi.spyOn(stream, "write").mockImplementation((text) => {
        logs.push(String(text));
        return true;
      });
    await runInstalledDeploymentAgent(config, revision, root, 501, "arm64", run);
    expect(await exists(join(location.home, "download"))).toBe(false);
    expect(logs.join("")).toContain('"requestId":"job"');
    expect(logs.join("")).not.toContain("private-token");
    expect(logs.join("")).toContain(outcome === "failed" ? '"exitCode":7' : '"outcome":"ready"');
    const reports = fetcher.mock.calls.filter(([input]) =>
      new Request(input).url.endsWith("/report"),
    );
    const last = reports.at(-1)!;
    expect(await new Request(...last).text()).toContain(
      outcome === "failed" ? '"state":"failed"' : '"state":"ready"',
    );
    expect(await readOptional(join(location.home, "agent.js"))).toBe(
      ["same_agent", "no_revision"].includes(outcome) ? undefined : "next attested code",
    );
  },
);

test("entry validates persisted configuration before running commands", async () => {
  const { root } = await fixture();
  await expect(
    runInstalledDeploymentAgent(join(root, "missing"), revision, root, 501, "arm64"),
  ).rejects.toThrow("ENOENT");
});
