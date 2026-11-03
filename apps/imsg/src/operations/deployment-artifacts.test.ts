import { join } from "node:path";
import { expect, test } from "vitest";
import { deploymentArtifact } from "./deployment-artifacts.ts";
import { atomicFile, exists } from "./deployment-files.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

const fixture = deploymentTestContext();
const revision = "a".repeat(40);
test("downloaded configuration and code are verified against the exact main commit before extraction or execution", async () => {
  const { location, run } = await fixture();
  await atomicFile(join(location.messagingHome, "deploy/token"), "private-token\n");
  run
    .mockResolvedValue("")
    .mockResolvedValueOnce(
      JSON.stringify([
        { databaseId: 123, headSha: revision, status: "in_progress", conclusion: "" },
      ]),
    )
    .mockResolvedValueOnce("456\n");
  const bundle = await deploymentArtifact(location, revision, run);
  expect(bundle).toBe(join(location.home, "download/bundle"));
  const calls = run.mock.calls;
  const attestation = calls.findIndex(([, args]) => args[0] === "attestation");
  const extract = calls.findIndex(([program]) => program === "/usr/bin/tar");
  const verify = calls.findIndex(([program]) => program === "/bin/bash");
  expect(attestation).toBeGreaterThan(0);
  expect(extract).toBeGreaterThan(attestation);
  expect(verify).toBeGreaterThan(extract);
  expect(calls[attestation]?.[1]).toEqual(
    expect.arrayContaining([
      "--source-ref",
      "refs/heads/main",
      "--source-digest",
      revision,
      "--deny-self-hosted-runners",
    ]),
  );
  expect(JSON.stringify(calls.map(([, args]) => args))).not.toContain("private-token");
  expect(calls[0]?.[2]?.env).toMatchObject({ GH_TOKEN: "private-token", GH_PROMPT_DISABLED: "1" });
});

test.each(["missing", "wrong_revision", "unpublished", "untrusted"])(
  "refuses %s artifacts and cleans abandoned downloads",
  async (state) => {
    const { location, run } = await fixture();
    await atomicFile(join(location.messagingHome, "deploy/token"), "secret");
    run.mockImplementation(async (_program, args) => {
      if (args[0] === "run" && args[1] === "list")
        return JSON.stringify(
          state === "missing"
            ? []
            : [
                {
                  databaseId: 123,
                  headSha: state === "wrong_revision" ? "b".repeat(40) : revision,
                  status: "completed",
                  conclusion: "success",
                },
              ],
        );
      if (args[0] === "api") return state === "unpublished" ? "" : "456";
      if (args[0] === "attestation") throw new Error("untrusted provenance");
      return "";
    });
    await expect(deploymentArtifact(location, revision, run)).rejects.toThrow(
      state === "untrusted" ? "untrusted provenance" : "MAC_ARTIFACT_NOT_READY",
    );
    expect(run.mock.calls.some(([program]) => program === "/usr/bin/tar")).toBe(false);
    expect(await exists(join(location.home, "download"))).toBe(false);
  },
);
