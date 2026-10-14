import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("CI api-msg artifact is checksummed, Bun-runnable and contains no SQL database dependency", async () => {
  const base = await mkdtemp(join(tmpdir(), "api-msg-artifact-"));
  const output = join(base, "bundle");
  try {
    execFileSync("bash", ["apps/api-msg/ops/build-bundle.sh", output], { cwd: process.cwd() });
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
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
