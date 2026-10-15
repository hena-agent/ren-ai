import { readFile } from "node:fs/promises";
import { readStateSnapshot } from "../src/state-snapshot.ts";

const [archive, extra] = process.argv.slice(2);
if (!archive || extra) throw new Error("Usage: import-application-state.ts PRIVATE-ARCHIVE");
const token = process.env["TOKEN_MANAGEMENT"];
const origin = process.env["API_APP_URL"];
if (!token || !origin) throw new Error("API_APP_URL and TOKEN_MANAGEMENT are required");
const url = new URL(origin);
if (url.protocol !== "https:" || url.username || url.password)
  throw new Error("API_APP_URL must be a credential-free HTTPS URL");
const snapshot = readStateSnapshot(JSON.parse(await readFile(archive, "utf8")));
const response = await fetch(new URL("/management/state/import", url), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(snapshot),
  signal: AbortSignal.timeout(120_000),
});
if (!response.ok)
  throw new Error(
    `Application state import failed (${response.status}; request ${response.headers.get("x-request-id") ?? "unavailable"})`,
  );
process.stdout.write(
  "Application state imported. Verify the private export and counts before enabling execution.\n",
);
