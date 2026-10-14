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
    const entry = join(artifact, "api-msg.js");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n// modified after attestation\n`);
    expect(() => execFileSync("bash", ["apps/api-msg/ops/verify-artifact.sh", artifact])).toThrow(
      "Command failed",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
