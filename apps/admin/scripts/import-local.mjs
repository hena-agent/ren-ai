import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import { readImportSource } from "../src/import-source.ts";
import { importCatalog } from "../src/catalog-import.ts";
import { reportFailure, writeLog } from "../src/logging.ts";

const args = process.argv.slice(2);
const sources = args.filter((arg) => !arg.startsWith("--"));
if (sources.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--check"))
  throw new Error("Usage: import:local [SOURCE_DIRECTORY] [--check]");
const directory = sources[0]
  ? resolve(sources[0])
  : fileURLToPath(new URL("../data/personas", import.meta.url));
const operationId = randomUUID();
let proxy;
try {
  const source = await readImportSource(directory);
  proxy = await getPlatformProxy({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    remoteBindings: false,
  });
  const report = await importCatalog(
    proxy.env.DB,
    proxy.env.IMAGES,
    source,
    args.includes("--check"),
    operationId,
  );
  writeLog({
    time: new Date().toISOString(),
    service: "admin",
    level: "info",
    event: "catalog.import.completed",
    operationId,
    outcome: "completed",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (cause) {
  reportFailure(cause, { stage: "catalog.import.local", operationId });
  process.exitCode = 1;
} finally {
  await proxy?.dispose();
}
