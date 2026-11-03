import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("installer accepts the built attested-artifact payload and rejects tampering", async () => {
  const base = await mkdtemp(join(tmpdir(), "api-msg-install-artifact-"));
  const artifact = join(base, "artifact");
  try {
    execFileSync("bash", ["apps/api-msg/ops/build-bundle.sh", artifact], { cwd: process.cwd() });
    expect(() =>
      execFileSync("bash", ["apps/api-msg/ops/verify-artifact.sh", artifact]),
    ).not.toThrow();
    for (const name of ["api-msg.js", "Dockerfile", "compose.yml", "verify-artifact.sh"]) {
      const entry = join(artifact, name);
      const original = await readFile(entry, "utf8");
      await writeFile(entry, `${original}\n# modified after attestation\n`);
      expect(() => execFileSync("bash", ["apps/api-msg/ops/verify-artifact.sh", artifact])).toThrow(
        "Command failed",
      );
      await writeFile(entry, original);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
