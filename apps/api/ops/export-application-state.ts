import { writeFile, stat } from "node:fs/promises";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect } from "effect";
import { exportApplicationState } from "../src/state-snapshot.ts";

if (process.env["CONFIRM_APPLICATION_STOPPED"] !== "yes")
  throw new Error("Confirm the old application intake and scheduling are stopped");
const [source, target, extra] = process.argv.slice(2);
if (!source || !target || extra)
  throw new Error("Usage: export-application-state.ts SOURCE-SQLITE NEW-PRIVATE-ARCHIVE");
const before = await stat(source);
const snapshot = await Effect.runPromise(
  Effect.scoped(exportApplicationState).pipe(
    Effect.provide(SqliteClient.layer({ filename: source, readonly: true, create: false })),
  ),
);
const after = await stat(source);
if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
  throw new Error("Source state changed during export; no archive written");
await writeFile(target, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
process.stdout.write(
  `Exported ${snapshot.tables.length} application tables; source opened read-only.\n`,
);
