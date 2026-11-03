import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { atomicFile, deploymentActive, discoverDeployment } from "./deployment-files.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    access: async (...args: Parameters<typeof fs.access>) => {
      if (["/opt/homebrew/bin/docker", "/usr/local/bin/docker"].includes(String(args[0])))
        throw new Error("not installed");
      return fs.access(...args);
    },
  };
});
const fixture = deploymentTestContext();
test("atomic writes create private files, replace contents, and surface filesystem failures", async () => {
  const { root } = await fixture();
  const file = join(root, "private/file");
  await atomicFile(file, "initial");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await atomicFile(file, new Uint8Array([65]), 0o700);
  expect(await readFile(file, "utf8")).toBe("A");
  expect((await stat(file)).mode & 0o777).toBe(0o700);
  await expect(atomicFile(join(file, "invalid"), "no")).rejects.toThrow("EEXIST");
});

test("process permission errors are treated as live locks; only ESRCH proves a dead owner", async () => {
  const { root } = await fixture();
  await atomicFile(join(root, "pid"), "123");
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
  expect(await deploymentActive(root)).toBe(true);
  kill.mockImplementation(() => {
    throw "not an Error";
  });
  expect(await deploymentActive(root)).toBe(true);
  kill.mockImplementation(() => {
    throw new Error("no code");
  });
  expect(await deploymentActive(root)).toBe(true);
});

test("discovery uses the installed updater's path and fails closed when Docker is unavailable", async () => {
  const { root, location, run } = await fixture();
  const entry = join(location.messagingHome, "imsg.js");
  const home = join(root, "Library/Application Support/ren-ai-api-msg");
  await atomicFile(join(location.messagingHome, "deploy/token"), "secret");
  await atomicFile(join(home, "api-msg.env"), "secret");
  await expect(discoverDeployment(entry, root, location.bun, run)).rejects.toMatchObject({
    code: "MAC_DOCKER_MISSING",
  });
  const docker = join(root, ".docker/bin/docker");
  await atomicFile(docker, "binary");
  expect((await discoverDeployment(entry, root, location.bun, run)).docker).toBe(docker);
  await atomicFile(join(root, "Library/LaunchAgents/im.renai.api-msg-deploy.plist"), "descriptor");
  run.mockResolvedValue(JSON.stringify({ ProgramArguments: [home] }));
  expect((await discoverDeployment(entry, root, location.bun, run)).docker).toBe(docker);
});
