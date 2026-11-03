import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { exists, type DeploymentLocation } from "./deployment-files.ts";
import { DeploymentFailure, type DeploymentCommand } from "./deployment-command.ts";

export async function installBrowserCli(
  location: DeploymentLocation,
  arch: string,
  run: DeploymentCommand,
) {
  const installed = join(location.apiMsgHome, "bin", "agent-browser");
  if (
    (await exists(installed)) &&
    (await run(installed, ["--version"]).catch(() => "")) === "agent-browser 0.41.0\n"
  )
    return;
  if (arch !== "arm64" && arch !== "x64")
    throw new DeploymentFailure("MAC_ARCHITECTURE_UNSUPPORTED");
  const directory = join(location.apiMsgHome, "browser");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await run(
    location.bun,
    ["add", "--cwd", directory, "--ignore-scripts", "--exact", "agent-browser@0.41.0"],
    { timeout: 300000 },
  );
  await mkdir(join(location.apiMsgHome, "bin"), { recursive: true, mode: 0o700 });
  await copyFile(
    join(directory, "node_modules", "agent-browser", "bin", `agent-browser-darwin-${arch}`),
    installed,
  );
  await chmod(installed, 0o700);
  if ((await run(installed, ["--version"])).trim() !== "agent-browser 0.41.0")
    throw new DeploymentFailure("MAC_BROWSER_VERSION_INVALID");
}
const chromeBinary = (app: string) => join(app, "Contents", "MacOS", "Google Chrome Canary");
export async function installCanary(
  location: DeploymentLocation,
  userHome: string,
  configured: string | undefined,
  run: DeploymentCommand,
) {
  for (const candidate of [
    configured,
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ]) {
    if (candidate && (await exists(candidate))) return candidate;
  }
  const destination = join(userHome, "Applications", "Google Chrome Canary.app");
  if (await exists(chromeBinary(destination))) return chromeBinary(destination);
  const staging = await mkdtemp(join(location.home, "canary-"));
  const mount = join(staging, "mount");
  let mounted = false;
  try {
    const dmg = join(staging, "canary.dmg");
    await run(
      "/usr/bin/curl",
      [
        "--fail",
        "--location",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--output",
        dmg,
        "https://dl.google.com/chrome/mac/universal/canary/googlechromecanary.dmg",
      ],
      { timeout: 300000 },
    );
    await mkdir(mount);
    await run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
    mounted = true;
    const app = join(mount, "Google Chrome Canary.app");
    await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      'anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
      app,
    ]);
    const identifier = await run("/usr/bin/defaults", [
      "read",
      join(app, "Contents", "Info"),
      "CFBundleIdentifier",
    ]);
    if (identifier.trim() !== "com.google.Chrome.canary")
      throw new DeploymentFailure("MAC_CANARY_IDENTITY_INVALID");
    await mkdir(join(userHome, "Applications"), { recursive: true, mode: 0o700 });
    await run("/usr/bin/ditto", [app, destination]);
    return chromeBinary(destination);
  } finally {
    if (mounted) await run("/usr/bin/hdiutil", ["detach", mount]).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}
