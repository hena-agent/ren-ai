import { mkdtemp, copyFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { browserCommands } from "./commands.ts";

const roots: string[] = [];
const ports: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    ports.splice(0).map((port) => fetch(`http://127.0.0.1:${port}/exit`).catch(() => undefined)),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "social-browser-"));
  roots.push(root);
  const executable = join(root, "fake-canary");
  await copyFile(new URL("../test/fake-chrome.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  return { root, executable };
}
test("native browser ownership persists in the dedicated profile and is reattached after executor replacement", async () => {
  const f = await fixture();
  const adapter = browserCommands(f.root, f.executable, "/bin/echo");
  const port = await adapter.open("first");
  ports.push(port);
  expect(await adapter.open("first")).toBe(port);
  const replacement = browserCommands(f.root, f.executable, "/bin/echo");
  expect(await replacement.open("first")).toBe(port);
  expect(
    await replacement.command("first", port, ["snapshot"], new AbortController().signal),
  ).toContain(`--cdp ${port} --json snapshot`);
  const failure = browserCommands(f.root, f.executable, "/not-a-browser");
  expect(await failure.open("first")).toBe(port);
  await expect(
    failure.command("first", port, ["snapshot"], new AbortController().signal),
  ).rejects.toMatchObject({ code: "SOCIAL_BROWSER_COMMAND" });
  expect(await failure.open("first")).toBe(port);
  const canceled = new AbortController();
  canceled.abort();
  await expect(adapter.command("first", port, ["snapshot"], canceled.signal)).rejects.toMatchObject(
    { code: "SOCIAL_BROWSER_COMMAND" },
  );
  expect(await adapter.open("first")).toBe(port);
  await fetch(`http://127.0.0.1:${port}/exit`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const restarted = await replacement.open("first");
  ports.push(restarted);
  expect(restarted).not.toBe(port);
});
test("invalid profile receipts cannot attach to another CDP target and spawn failures are recoverable", async () => {
  const f = await fixture();
  const directory = join(f.root, "profiles", "first");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "DevToolsActivePort"), "not-a-port\nwrong");
  const missing = browserCommands(f.root, "/not-canary", "/bin/echo");
  await expect(missing.open("first")).rejects.toThrow("ENOENT");
  await expect(missing.open("first")).rejects.toThrow("ENOENT");
  const live = browserCommands(f.root, f.executable, "/bin/echo");
  const port = await live.open("first");
  ports.push(port);
  const changed = browserCommands(f.root, "/not-canary", "/bin/echo");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1/wrong" }),
  );
  await expect(changed.open("first")).rejects.toThrow("ENOENT");
});
test("a launched browser without CDP readiness is terminated rather than attaching to a default browser", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "profiles", "first"), { recursive: true });
  await writeFile(join(f.root, "profiles", "first", "DevToolsActivePort"), "1234\n/wrong");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  await expect(browserCommands(f.root, "/usr/bin/true", "/bin/echo").open("first")).rejects.toThrow(
    "did not become ready",
  );
}, 15000);
