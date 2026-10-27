import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getPlatformProxy } from "wrangler";
import { backfillThumbnails } from "../src/thumbnail-backfill.ts";
import { loggedJob, operation, writeLog } from "../src/logging.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--remote")) throw new Error("Usage: thumbnails [--remote]");
const remote = args.includes("--remote");
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
let directory;
let proxy;
try {
  let config = configPath;
  if (remote) {
    const deployed = await readFile(configPath, "utf8");
    const setting = (name) => {
      const value = new RegExp(`"${name}":\\s*"([^"]+)"`).exec(deployed)?.[1];
      if (!value) throw new Error(`wrangler.jsonc has no ${name}`);
      return value;
    };
    // Only the image bucket connects to production; nothing else is read or written.
    directory = await mkdtemp(join(tmpdir(), "admin-thumbnails-"));
    config = join(directory, "wrangler.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "persona-admin-thumbnails",
        account_id: setting("account_id"),
        compatibility_date: setting("compatibility_date"),
        r2_buckets: [{ binding: "IMAGES", bucket_name: setting("bucket_name"), remote: true }],
      }),
    );
  }
  proxy = await getPlatformProxy({ configPath: config, remoteBindings: remote });
  const bucket = proxy.env.IMAGES;
  const report = await loggedJob(
    randomUUID(),
    {},
    () => operation("thumbnail.backfill", {}, () => backfillThumbnails(bucket)),
    writeLog,
    "/thumbnail-backfill",
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await proxy?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
}
