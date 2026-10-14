import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, test } from "vitest";
import { migrate } from "./database.ts";
import { exportReadOnlyApplicationState, readStateSnapshot } from "./state-snapshot.ts";

test("the real Node archive command opens stopped source read-only and creates a private non-overwriting archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "application-export-"));
  const source = join(root, "server.sqlite");
  const target = join(root, "state.json");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO blocked VALUES ('source-private-marker',123)`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: source }))),
    );
    const before = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
    expect(await readdir(root)).toEqual(["server.sqlite"]);
    const command = fileURLToPath(new URL("../ops/export-application-state.ts", import.meta.url));
    const output = execFileSync(process.execPath, [command, source, target], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, CONFIRM_APPLICATION_STOPPED: "yes" },
      encoding: "utf8",
    });
    expect(output).not.toContain("source-private-marker");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    ).toBe(before);
    const snapshot = readStateSnapshot(JSON.parse(await readFile(target, "utf8")));
    expect(snapshot.tables.find((table) => table.name === "blocked")!.rows).toEqual([
      ["source-private-marker", 123],
    ]);
    expect(() =>
      execFileSync(process.execPath, [command, source, target], {
        env: { ...process.env, CONFIRM_APPLICATION_STOPPED: "yes" },
        stdio: "pipe",
      }),
    ).toThrow(/EEXIST/);
    expect(await readdir(root)).toEqual(["server.sqlite", "state.json"]);
    expect(() =>
      execFileSync(process.execPath, [command, source, join(root, "unconfirmed.json")], {
        env: { ...process.env, CONFIRM_APPLICATION_STOPPED: "no" },
        stdio: "pipe",
      }),
    ).toThrow("Confirm the old application intake and scheduling are stopped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the stopped source export includes uncheckpointed WAL rows without modifying source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "application-export-wal-"));
  // URI-sensitive characters must remain part of the filename, not query options.
  const source = join(root, "server #?%.sqlite");
  const target = join(root, "state.json");
  try {
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(${JSON.stringify(source)});
       db.exec("PRAGMA journal_mode=WAL; CREATE TABLE blocked(handle TEXT, created_at INTEGER); INSERT INTO blocked VALUES ('wal-private-marker',456)");
       process.exit(0);`,
    ]);
    const files = await readdir(root);
    expect(files).toEqual(["server #?%.sqlite", "server #?%.sqlite-shm", "server #?%.sqlite-wal"]);
    const before = await Promise.all(files.map((file) => readFile(join(root, file))));
    const command = fileURLToPath(new URL("../ops/export-application-state.ts", import.meta.url));
    const output = execFileSync(process.execPath, [command, source, target], {
      env: { ...process.env, CONFIRM_APPLICATION_STOPPED: "yes" },
      encoding: "utf8",
    });
    expect(output).not.toContain("wal-private-marker");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await Promise.all(files.map((file) => readFile(join(root, file))))).toEqual(before);
    const snapshot = readStateSnapshot(JSON.parse(await readFile(target, "utf8")));
    expect(snapshot.tables.find((table) => table.name === "blocked")!.rows).toEqual([
      ["wal-private-marker", 456],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deferred snapshot transaction commits success and rolls back failure before retry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE blocked (handle TEXT, created_at INTEGER)`;
      yield* sql`INSERT INTO blocked VALUES ('transaction-marker',789)`;
      expect((yield* exportReadOnlyApplicationState).tables[0]!.rows).toEqual([
        ["transaction-marker", 789],
      ]);
      yield* sql.unsafe('CREATE TABLE "invalid-name" (id INTEGER)');
      const failed = yield* Effect.exit(exportReadOnlyApplicationState);
      expect(Exit.isFailure(failed)).toBe(true);
      yield* sql.unsafe('DROP TABLE "invalid-name"');
      // A leaked BEGIN would prevent this retry from starting another transaction.
      expect((yield* exportReadOnlyApplicationState).tables[0]!.name).toBe("blocked");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});
