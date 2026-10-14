import { readFile, writeFile } from "node:fs/promises";
import { patchProxy } from "../src/operations/proxy-patch.ts";

const [source, destination] = process.argv.slice(2);
if (!source || !destination || source === destination)
  throw new Error("Usage: bun ops/patch-opencode-proxy.ts ORIGINAL REVIEW-COPY (different paths)");
await writeFile(destination, patchProxy(await readFile(source, "utf8")), {
  flag: "wx",
  mode: 0o600,
});
