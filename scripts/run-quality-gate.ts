import { spawnSync } from "node:child_process";
import process from "node:process";
import { qualityCommand } from "./quality-commands.ts";

const [gate] = process.argv.slice(2);
const command = qualityCommand(gate ?? "");

if (command === null) {
  throw new Error(`Unknown quality gate: ${gate}`);
}

const [binary, ...args] = command;
const result = spawnSync(binary ?? "", args, { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
