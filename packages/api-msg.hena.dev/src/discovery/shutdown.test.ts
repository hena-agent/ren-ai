import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

test.each(["SIGINT", "SIGTERM"] as const)(
  "Bun watch exits after %s instead of keeping Turbo alive",
  async (signal) => {
    const root = await mkdtemp(join(tmpdir(), "discovery-shutdown-"));
    const child = spawn(
      "bun",
      ["--watch", fileURLToPath(new URL("../discovery-entry.mjs", import.meta.url))],
      {
        cwd: root,
        detached: true,
        env: {
          PATH: process.env["PATH"],
          HOME: root,
          PORT: "0",
          DISCOVERY_DATABASE: join(root, "discovery.sqlite"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(
        () => {
          expect(child.exitCode).toBeNull();
          expect(output).toContain("[discovery-api]");
        },
        { timeout: 10_000 },
      );
      child.kill(signal);
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Discovery watch process did not exit after shutdown")),
            2000,
          );
        }),
      ]);
      expect(result).toBe(130);
      expect(child.signalCode).toBeNull();
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid!, "SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
