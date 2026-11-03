import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { installBrowserCli, installCanary } from "./deployment-browser.ts";
import { atomicFile } from "./deployment-files.ts";
import { deploymentTestContext } from "./deployment.test-helper.ts";

vi.mock("./deployment-files.ts", async (importOriginal) => {
  const files = await importOriginal<typeof import("./deployment-files.ts")>();
  return {
    ...files,
    exists: (path: string) =>
      path.startsWith("/Applications/") ? Promise.resolve(false) : files.exists(path),
  };
});

const fixture = deploymentTestContext();
test.each(["arm64", "x64"])(
  "installs the pinned native browser CLI for %s without package scripts",
  async (arch) => {
    const { location, run } = await fixture();
    const binary = join(location.apiMsgHome, "bin/agent-browser");
    run.mockImplementation(async (_program, args) => {
      if (args[0] === "add")
        await atomicFile(
          join(
            location.apiMsgHome,
            "browser/node_modules/agent-browser/bin",
            `agent-browser-darwin-${arch}`,
          ),
          "native browser",
        );
      return "agent-browser 0.41.0\n";
    });
    await installBrowserCli(location, arch, run);
    expect(run).toHaveBeenCalledWith(
      location.bun,
      expect.arrayContaining(["--ignore-scripts", "--exact", "agent-browser@0.41.0"]),
      { timeout: 300000 },
    );
    expect((await stat(binary)).mode & 0o777).toBe(0o700);
    run.mockClear();
    await installBrowserCli(location, arch, run);
    expect(run).toHaveBeenCalledOnce();
  },
);

test("browser installation rejects unsupported architectures and verifies the installed version", async () => {
  const { location, run } = await fixture();
  await expect(installBrowserCli(location, "ia32", run)).rejects.toMatchObject({
    code: "MAC_ARCHITECTURE_UNSUPPORTED",
  });
  await atomicFile(join(location.apiMsgHome, "bin/agent-browser"), "outdated");
  await atomicFile(
    join(location.apiMsgHome, "browser/node_modules/agent-browser/bin/agent-browser-darwin-arm64"),
    "native",
  );
  run.mockRejectedValueOnce(new Error("old broken cli")).mockResolvedValue("wrong version");
  await expect(installBrowserCli(location, "arm64", run)).rejects.toMatchObject({
    code: "MAC_BROWSER_VERSION_INVALID",
  });
});

test("an existing configured or user-owned Canary installation is reused", async () => {
  const { root, location, run } = await fixture();
  const configured = join(root, "custom chrome");
  await atomicFile(configured, "chrome");
  expect(await installCanary(location, root, configured, run)).toBe(configured);
  const user = join(
    root,
    "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  );
  await atomicFile(user, "chrome");
  expect(await installCanary(location, root, undefined, run)).toBe(user);
  expect(run).not.toHaveBeenCalled();
});

test.each(["success", "identity", "download", "detach"])(
  "Canary download verifies Google's signer and cleans mounted images: %s",
  async (outcome) => {
    const { root, location, run } = await fixture();
    await atomicFile(join(location.home, "receipt"), "ready");
    run.mockImplementation(async (program, args) => {
      if (program === "/usr/bin/curl" && outcome === "download") throw new Error("network failed");
      if (program === "/usr/bin/defaults")
        return outcome === "identity" ? "com.attacker.chrome" : "com.google.Chrome.canary\n";
      if (program === "/usr/bin/hdiutil" && args[0] === "detach" && outcome === "detach")
        throw new Error("detach failed");
      return "";
    });
    const result = await installCanary(location, root, "/missing/chrome", run).catch(
      (cause: Error) => cause.message,
    );
    expect(result).toBe(
      outcome === "identity"
        ? "MAC_CANARY_IDENTITY_INVALID"
        : outcome === "download"
          ? "network failed"
          : join(root, "Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
    );
    expect(
      run.mock.calls
        .filter(([program]) => program === "/usr/bin/codesign")
        .flatMap(([, args]) => args.filter((arg) => arg.includes("anchor apple"))),
    ).toEqual(
      outcome === "download"
        ? []
        : ['anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"'],
    );
    expect((await readdir(location.home)).filter((name) => name.startsWith("canary-"))).toEqual([]);
  },
);
