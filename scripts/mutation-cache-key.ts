import { execFileSync } from "node:child_process";
import process from "node:process";
import { mutationCacheKey, mutationFiles } from "./mutation-ci.ts";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
process.stdout.write(`key=${mutationCacheKey(trackedFiles, mutationFiles(), process.cwd())}\n`);
