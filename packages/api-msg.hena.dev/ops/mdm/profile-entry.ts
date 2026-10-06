import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { discoverPermissionProfile } from "../../src/provisioning/profile.ts";
import { deliverPermissionProfile } from "../../src/provisioning/fleet.ts";

const home = process.env["MESSAGING_HOME"] ?? "/usr/local/lib/ren-ai-messaging";
const profile = await discoverPermissionProfile(
  { bun: realpathSync(resolve(home, "bin/bun")), imsg: realpathSync(resolve(home, "bin/imsg")) },
  async (file, args) => {
    // codesign writes its designated requirement to stderr, not stdout.
    const result = spawnSync(file, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Mac identity inspection failed: ${file}`);
    return result.stdout + result.stderr;
  },
);
const path = resolve(
  process.env["PPPC_PROFILE_PATH"] ?? "ops/mdm/.generated/messaging.mobileconfig",
);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, profile.xml, { mode: 0o600 });
execFileSync("/usr/bin/plutil", ["-lint", path], { stdio: "inherit" });
if (process.argv[2] === "--apply") {
  const result = await deliverPermissionProfile(
    process.env["FLEET_URL"] ?? "https://fleet.hena.dev",
    process.env["FLEET_API_TOKEN"] ?? "",
    profile,
    fetch,
  );
  process.stdout.write(`Fleet permission profile ${result}: ${profile.identifier}\n`);
} else {
  process.stdout.write(`Generated ${path}; use --apply to deliver through Fleet MDM.\n`);
}
