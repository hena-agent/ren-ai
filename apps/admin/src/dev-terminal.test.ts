import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { Schema } from "effect";

const Package = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
const ptyRunner = `import os,pty,fcntl,termios,struct,sys,signal,time
pid,master=pty.fork()
if pid==0: os.execvp(sys.argv[1],sys.argv[1:])
def stop(signum,frame):
 try: os.killpg(pid,signal.SIGINT)
 except ProcessLookupError: pass
 time.sleep(0.3)
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack("HHHH",40,140,0,0))
try:
 while True:
  data=os.read(master,65536)
  if not data: break
  os.write(1,data)
except OSError: pass`;

test("the actual Turbo and Bun dev commands expose failure diagnostics in the parent terminal and retain them through reload", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), "admin-dev-terminal-"));
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(temp, "logs", `admin-${date}.jsonl`);
  await mkdir(join(temp, "packages/a-focus"), { recursive: true });
  await mkdir(join(temp, "packages/z-admin"), { recursive: true });
  await writeFile(
    join(temp, "package.json"),
    JSON.stringify({
      name: "admin-terminal-fixture",
      private: true,
      workspaces: ["packages/*"],
      packageManager: "bun@1.4.2",
    }),
  );
  await writeFile(join(temp, "turbo.json"), await readFile(join(root, "turbo.json"), "utf8"));
  await writeFile(
    join(temp, "packages/a-focus/package.json"),
    JSON.stringify({ name: "a-focus", version: "1.0.0", scripts: { dev: "bun focus.mjs" } }),
  );
  await writeFile(
    join(temp, "packages/a-focus/focus.mjs"),
    'console.log("FOCUS_TASK_READY");setInterval(()=>console.log("FOCUS_TASK_TICK"),1000);',
  );
  const admin = Schema.decodeUnknownSync(Package)(
    JSON.parse(await readFile(join(root, "apps/admin/package.json"), "utf8")),
  );
  const entry = join(temp, "packages/z-admin/entry.mjs");
  const entrySource = `import ${JSON.stringify(join(root, "apps/admin/src/run.mjs"))};\n`;
  await writeFile(entry, entrySource);
  await writeFile(
    join(temp, "packages/z-admin/package.json"),
    JSON.stringify({
      name: "z-admin",
      version: "1.0.0",
      scripts: { dev: admin.scripts["dev"]!.replace("src/run.mjs", "entry.mjs") },
    }),
  );
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: temp, stdio: "ignore" });
  const workspace = Schema.decodeUnknownSync(Package)(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  );
  const command = workspace.scripts["dev"]!.split(" ").slice(1);
  const child = spawn(
    "python3",
    [
      "-c",
      ptyRunner,
      "bun",
      join(root, "node_modules/turbo/bin/turbo"),
      ...command,
      "--concurrency=3",
      "--env-mode=loose",
      "--no-update-notifier",
    ],
    {
      cwd: temp,
      detached: true,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: "140",
        LINES: "40",
        PORT: "0",
        ADMIN_PASSWORD: "terminal-test",
        GEMINI_API_KEY: "",
        PERSONA_DIRECTORY: join(temp, "personas"),
        ADMIN_LOG_DIRECTORY: join(temp, "logs"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  try {
    let origin = "";
    await vi.waitFor(
      async () => {
        expect(child.exitCode).toBeNull();
        const logs = await readFile(logFile, "utf8");
        origin = /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(logs)![1]!;
        expect(origin).not.toBe("");
      },
      { timeout: 15000, interval: 100 },
    );
    const headers = {
      Authorization: `Basic ${Buffer.from("admin:terminal-test").toString("base64")}`,
    };
    const markup = await (await fetch(`${origin}/new`, { headers })).text();
    const response = await fetch(`${origin}/personas`, {
      method: "POST",
      headers: { ...headers, Origin: origin },
      body: new URLSearchParams({
        draft: /name="draft" value="([^"]+)"/.exec(markup)![1]!,
        seed: "private terminal diagnostic idea",
        gender: "female",
        intent: "character",
      }),
    });
    expect(response.status).toBe(503);
    const id = response.headers.get("x-request-id")!;
    await vi.waitFor(() =>
      expect(
        output
          .split(/\r?\n/)
          .some(
            (line) =>
              line.includes(id) &&
              line.includes('"event":"operation.failed"') &&
              line.includes('"code":"missing_key"'),
          ),
      ).toBe(true),
    );
    expect(output).toContain("FOCUS_TASK_READY");
    expect(output).not.toContain("private terminal diagnostic idea");
    const offset = output.length;
    await writeFile(entry, `${entrySource}// trigger isolated reload\n`);
    await vi.waitFor(
      async () =>
        expect((await readFile(logFile, "utf8")).match(/"event":"server.started"/g)).toHaveLength(
          2,
        ),
      { timeout: 10000, interval: 100 },
    );
    await vi.waitFor(() => expect(output.slice(offset)).toContain('"event":"server.started"'));
    expect(output.slice(offset)).not.toContain("\u001b[2J");
    expect(output.slice(offset)).not.toContain("\u001b[3J");
    expect(output).toContain(id);
  } finally {
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    process.kill(-child.pid!, "SIGTERM");
    await exit;
    await rm(temp, { recursive: true, force: true });
  }
}, 30000);
