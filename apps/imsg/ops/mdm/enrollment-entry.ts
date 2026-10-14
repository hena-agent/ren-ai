import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { downloadEnrollmentProfile } from "../../src/provisioning/fleet.ts";

const profile = await downloadEnrollmentProfile(
  process.env["FLEET_URL"] ?? "https://fleet.hena.dev",
  process.env["FLEET_API_TOKEN"] ?? "",
  fetch,
);
const directory = resolve("ops/mdm/.generated");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const path = resolve(directory, "enrollment.mobileconfig");
writeFileSync(path, Buffer.from(profile), { mode: 0o600 });
chmodSync(path, 0o600);
execFileSync("/usr/bin/security", ["cms", "-D", "-n", "-i", path], { stdio: "ignore" });
process.stdout.write(`Downloaded signed company-owned OTA enrollment profile: ${path}\n`);
