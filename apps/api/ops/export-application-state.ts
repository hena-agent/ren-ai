import { writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect } from "effect";
import { exportReadOnlyApplicationState } from "../src/state-snapshot.ts";

if (process.env["CONFIRM_APPLICATION_STOPPED"] !== "yes")
  throw new Error("Confirm the old application intake and scheduling are stopped");
const [source, target, extra] = process.argv.slice(2);
if (!source || !target || extra)
  throw new Error("Usage: export-application-state.ts SOURCE-SQLITE NEW-PRIVATE-ARCHIVE");
const before = await stat(source);
const filename = pathToFileURL(source);
filename.searchParams.set("mode", "ro");
// SQLite otherwise opens/maps the existing WAL index read-write even for a reader.
filename.searchParams.set("readonly_shm", "1");
// A clean close removes WAL sidecars but leaves WAL mode in the header. Immutable
// reads need no sidecars; never use them with a WAL, whose committed rows they ignore.
if (!existsSync(`${source}-wal`)) filename.searchParams.set("immutable", "1");
const snapshot = await Effect.runPromise(
  Effect.scoped(exportReadOnlyApplicationState).pipe(
    Effect.provide(SqliteClient.layer({ filename: filename.href, readonly: true, create: false })),
  ),
);
const after = await stat(source);
if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
  throw new Error("Source state changed during export; no archive written");
await writeFile(target, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
process.stdout.write(
  `Exported ${snapshot.tables.length} application tables; source opened read-only.\n`,
);
