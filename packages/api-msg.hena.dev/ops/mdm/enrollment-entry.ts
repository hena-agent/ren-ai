import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { downloadEnrollmentProfile } from "../../src/provisioning/fleet.ts";

const xml = await downloadEnrollmentProfile(
  process.env["FLEET_URL"] ?? "https://fleet.hena.dev",
  process.env["FLEET_API_TOKEN"] ?? "",
  fetch,
);
const directory = resolve("ops/mdm/.generated");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = resolve(directory, "enrollment.mobileconfig");
writeFileSync(path, xml, { mode: 0o600 });
execFileSync("/usr/bin/plutil", ["-lint", path], { stdio: "inherit" });
process.stdout.write(`Downloaded Device Enrollment profile: ${path}\n`);
