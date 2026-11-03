import { join } from "node:path";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { atomicFile, exists, readOptional } from "./deployment-files.ts";
import { provisionMacRuntime, recoverMacRuntime } from "./deployment-provision.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

vi.mock("./deployment-browser.ts", () => ({
  installBrowserCli: async () => {},
  installCanary: async () => "/existing/canary",
}));
const fixture = deploymentTestContext();
const revision = "b".repeat(40);
const payload = [
  "api-msg.js",
  "api-msg-verify.js",
  "social.js",
  "api-msg.graph.json",
  "api-msg-verify.graph.json",
  "social.graph.json",
  "artifact.info",
];
async function setup(existing = false) {
  const f = await fixture();
  const bundle = join(f.root, "attested bundle");
  const profile = join(f.root, "original profiles");
  const plist = join(f.root, "Library/LaunchAgents/im.renai.social.plist");
  const marker = join(f.location.home, "previous/transaction.json");
  for (const name of [...payload, "Dockerfile", "Dockerfile.dockerignore"])
    await atomicFile(join(bundle, name), `new ${name}`);
  for (const name of [...payload, "SHA256SUMS", "compose.yml", "api-msg.env", "tunnel.token"])
    await atomicFile(join(f.location.apiMsgHome, name), `old ${name}`);
  await atomicFile(join(profile, "vault.json"), "private encrypted vault");
  await atomicFile(join(profile, "profiles/threads/Default/Cookies"), "private cookies");
  if (existing) {
    await atomicFile(plist, "old social descriptor");
    for (const name of [
      "mac-runtime.compose.yml",
      "Dockerfile.mac-runtime",
      "Dockerfile.mac-runtime.dockerignore",
    ])
      await atomicFile(join(f.location.apiMsgHome, name), `old ${name}`);
  }
  f.run.mockImplementation(async (program, args) => {
    if (program === f.location.bun) return JSON.stringify({ SOCIAL_HOME: profile });
    if (program === "/usr/bin/plutil" && args.includes("-o"))
      return JSON.stringify({
        ProgramArguments: [],
        EnvironmentVariables: { SOCIAL_HOME: profile },
      });
    return "";
  });
  const options = {
    location: f.location,
    bundle,
    revision,
    userHome: f.root,
    uid: 501,
    arch: "arm64",
    run: f.run,
    progress: vi.fn<(state: string, stage: string) => Promise<void>>(async () => {}),
  };
  const preserved = async () => {
    expect(await readFile(join(profile, "vault.json"), "utf8")).toBe("private encrypted vault");
    expect(await readFile(join(profile, "profiles/threads/Default/Cookies"), "utf8")).toBe(
      "private cookies",
    );
    for (const name of ["compose.yml", "api-msg.env", "tunnel.token"])
      expect(await readFile(join(f.location.apiMsgHome, name), "utf8")).toBe(`old ${name}`);
  };
  return { ...f, options, plist, profile, marker, preserved };
}

test.each([false, true])(
  "installation preserves profiles, vault, credentials and ingress configuration (existing native service: %s)",
  async (existing) => {
    const f = await setup(existing);
    await provisionMacRuntime(f.options);
    await f.preserved();
    for (const name of payload)
      expect(await readFile(join(f.location.apiMsgHome, name), "utf8")).toBe(`new ${name}`);
    expect(await exists(f.marker)).toBe(false);
    expect(await readFile(f.plist, "utf8")).toContain(f.profile);
    expect(await readFile(join(f.location.apiMsgHome, "SHA256SUMS"), "utf8")).toContain(
      "Dockerfile.mac-runtime",
    );
    const overlay = await readFile(join(f.location.apiMsgHome, "mac-runtime.compose.yml"), "utf8");
    expect(overlay).toContain("host.docker.internal:5407");
    expect(f.run).toHaveBeenCalledWith(
      f.location.docker,
      expect.arrayContaining(["--no-deps", "--wait", "--wait-timeout", "120", "api-msg"]),
      { timeout: 180000 },
    );
    expect(f.options.progress).toHaveBeenCalledWith("starting", "gateway");
  },
);

test.each([false, true])(
  "failed gateway restart durably restores prior code and native service (existing: %s)",
  async (existing) => {
    const f = await setup(existing);
    const run = f.run.getMockImplementation()!;
    let failed = false;
    f.run.mockImplementation(async (...args) => {
      if (args[1][0] === "bootout") throw new Error("not loaded");
      if (!failed && args[1].includes("build")) {
        failed = true;
        throw new Error("docker failed");
      }
      return run(...args);
    });
    await expect(provisionMacRuntime(f.options)).rejects.toThrow("docker failed");
    await f.preserved();
    for (const name of [...payload, "SHA256SUMS"])
      expect(await readFile(join(f.location.apiMsgHome, name), "utf8")).toBe(`old ${name}`);
    expect(await readOptional(f.plist)).toBe(existing ? "old social descriptor" : undefined);
    expect(await exists(f.marker)).toBe(false);
    expect(await exists(join(f.location.apiMsgHome, "mac-runtime.compose.yml"))).toBe(existing);
  },
);

test.each(["not_applied", "healthy", "degraded", "wrong_revision", "invalid", "missing_overlay"])(
  "actor replacement recovers a persisted transaction: %s",
  async (state) => {
    const f = await setup();
    const backup = join(f.location.home, "previous");
    await mkdir(backup, { recursive: true });
    await atomicFile(join(backup, "api-msg.js"), "previous runtime");
    await atomicFile(
      f.marker,
      JSON.stringify({
        files: ["api-msg.js"],
        hadPlist: false,
        revision,
        applying: state !== "not_applied",
      }),
    );
    if (state !== "missing_overlay")
      await atomicFile(join(f.location.apiMsgHome, "mac-runtime.compose.yml"), "overlay");
    const run = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (...args) => {
      if (args[1].includes("-e")) {
        if (state === "degraded") throw new Error("unavailable");
        if (state === "invalid") return "not json";
        return JSON.stringify({
          service: "api-msg",
          status: "ready",
          revision: state === "wrong_revision" ? "c".repeat(40) : revision,
          social: { status: "ready" },
        });
      }
      return run(...args);
    });
    await recoverMacRuntime(f.location, f.root, 501, f.run);
    const rollback = !["not_applied", "healthy"].includes(state);
    expect(await readFile(join(f.location.apiMsgHome, "api-msg.js"), "utf8")).toBe(
      rollback ? "previous runtime" : "old api-msg.js",
    );
    expect(await exists(f.marker)).toBe(false);
    await f.preserved();
  },
);

test("rollback failure retains its journal for the next process instead of declaring success", async () => {
  const f = await setup();
  const run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (...args) => {
    if (args[1].includes("build")) throw new Error("docker still unavailable");
    return run(...args);
  });
  await expect(provisionMacRuntime(f.options)).rejects.toThrow("docker still unavailable");
  expect(await exists(f.marker)).toBe(true);
  await f.preserved();
  expect(await readdir(f.location.apiMsgHome)).not.toContain("api-msg.js.tmp");
});
