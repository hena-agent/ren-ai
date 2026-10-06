import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { createEmbeddedRoutes } from "@opencode/server/routes";
import { exportOffline } from "../src/operations/offline-export.ts";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Supply the source persona location recorded in the old sessions");
await mkdir("/scratch/config", { recursive: true });
await writeFile("/scratch/opencode.sqlite", await readFile("/snapshot/opencode.sqlite"), {
  flag: "wx",
  mode: 0o600,
});
const archive = await Effect.runPromise(
  Effect.scoped(
    exportOffline(
      createEmbeddedRoutes({
        database: { path: "/scratch/opencode.sqlite" },
        config: { directory: "/scratch/config", project: false },
        models: { fetch: false },
        fs: { filewatcher: false, fff: false },
      }),
      directory,
    ),
  ),
);
await writeFile("/output/sessions.json", archive, { flag: "wx", mode: 0o600 });
process.stdout.write(
  "Exported the stopped copy; no intake, restart sweep, or original database writes.\n",
);
