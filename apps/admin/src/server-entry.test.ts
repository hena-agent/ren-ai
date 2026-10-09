import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the real Bun entry starts and serves the full browser bundle without subprocess buffer limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "admin-entry-"));
  const child = spawn("bun", [fileURLToPath(new URL("./run.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: "0",
      PERSONA_DIRECTORY: directory,
      ADMIN_PASSWORD: "entry-test",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    errors += data.toString();
  });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Admin entry startup timed out")), 15000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Admin entry exited ${code}: ${errors.slice(0, 300)}`));
      });
      child.stdout.on("data", () => {
        const url = /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(output)?.[1];
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      });
    });
    const headers = {
      Authorization: `Basic ${Buffer.from("admin:entry-test").toString("base64")}`,
    };
    const page = await fetch(`${origin}/new`, { headers });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('type="module"');
    const script = await fetch(`${origin}/pending.js`, { headers });
    expect(script.status).toBe(200);
    expect((await script.arrayBuffer()).byteLength).toBeGreaterThan(1024 * 1024);
    expect(errors).not.toContain("ENOBUFS");
    expect(child.exitCode).toBeNull();
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    if (child.exitCode === null) await exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
