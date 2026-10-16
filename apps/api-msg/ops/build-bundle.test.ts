import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow the bundled process listener event
function listenerUrl(input: unknown) {
  if (
    typeof input !== "object" ||
    input === null ||
    !("url" in input) ||
    typeof input.url !== "string"
  )
    throw new Error("Expected bundled service listener");
  return input.url;
}

test("CI api-msg artifact is checksummed, Bun-runnable and contains no SQL database dependency", async () => {
  const base = await mkdtemp(join(tmpdir(), "api-msg-artifact-"));
  const output = join(base, "bundle");
  try {
    const revision = "b".repeat(40);
    execFileSync("bash", ["apps/api-msg/ops/build-bundle.sh", output], {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_SHA: revision },
    });
    const info = await readFile(join(output, "artifact.info"), "utf8");
    const graph = await readFile(join(output, "api-msg.graph.json"), "utf8");
    const verifyGraph = await readFile(join(output, "api-msg-verify.graph.json"), "utf8");
    expect(info).toBe("format=api-msg-v1\n");
    expect(graph + verifyGraph).not.toMatch(/@effect\/sql|sqlite|better-sqlite3/i);
    expect(() =>
      execFileSync("bash", ["apps/api-msg/ops/verify-artifact.sh", output], { cwd: process.cwd() }),
    ).not.toThrow("checksum");
    for (const file of [
      "api-msg.js",
      "api-msg-verify.js",
      "api-msg.graph.json",
      "api-msg-verify.graph.json",
    ])
      expect((await readFile(join(output, file), "utf8")).length).toBeGreaterThan(0);
    const service = spawn("bun", [join(output, "api-msg.js")], {
      env: {
        ...process.env,
        PORT: "0",
        TOKEN_MANAGEMENT: "artifact-secret",
        OPENCODE_URL: "http://127.0.0.1:4096",
        OPENCODE_AUTHORIZATION: "Basic test",
        IMSG_URL: "http://127.0.0.1:4702/rpc",
        IMSG_TOKEN: "imsg-secret",
        BUILD_REVISION: "runtime-must-not-override-artifact",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        service.stdout.once("data", (data: Buffer) => resolve(data.toString()));
        service.once("error", reject);
      });
      const response = await fetch(new URL("/health", listenerUrl(JSON.parse(line))), {
        headers: { Authorization: "Bearer artifact-secret" },
      });
      expect(await response.json()).toMatchObject({ service: "api-msg", revision });
    } finally {
      service.kill();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
