import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
      ADMIN_LOG_DIRECTORY: join(directory, "logs"),
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
    const markup = await page.text();
    expect(markup).toContain('type="module"');
    const script = await fetch(`${origin}/pending.js`, { headers });
    expect(script.status).toBe(200);
    expect((await script.arrayBuffer()).byteLength).toBeGreaterThan(1024 * 1024);
    const styles = await fetch(`${origin}/style.css`, { headers });
    const stylesheet = await styles.text();
    expect(stylesheet).toContain(".document-tabs");
    expect(stylesheet).toContain(".editor-back");
    const failed = await fetch(`${origin}/personas`, {
      method: "POST",
      headers: { ...headers, Origin: origin },
      body: new URLSearchParams({
        draft: /name="draft" value="([^"]+)"/.exec(markup)![1]!,
        seed: "private diagnostic idea",
        gender: "female",
        intent: "character",
      }),
    });
    expect(failed.status).toBe(503);
    const id = failed.headers.get("x-request-id")!;
    expect(await failed.text()).toContain(id);
    const file = join(directory, "logs", `admin-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const persisted = await readFile(file, "utf8");
    expect(persisted).toContain(id);
    expect(persisted).toContain('"code":"missing_key"');
    expect(persisted).toContain('"stage":"generation.api"');
    expect(persisted).toContain('"event":"request.completed"');
    expect(persisted).not.toContain("private diagnostic idea");
    expect(persisted).not.toContain(headers.Authorization);
    expect(persisted).not.toContain(/name="draft" value="([^"]+)"/.exec(markup)![1]!);
    expect(errors).toContain(id);
    expect(errors).toContain('"event":"operation.failed"');
    expect(errors).toContain('"code":"missing_key"');
    expect(errors).not.toContain("private diagnostic idea");
    expect(errors).not.toContain("ENOBUFS");
    expect(child.exitCode).toBeNull();
  } finally {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    if (child.exitCode === null) await exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
