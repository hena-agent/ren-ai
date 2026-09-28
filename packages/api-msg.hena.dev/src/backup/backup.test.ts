import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Deferred, Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { makeBackup } from "./backup.ts";

vi.mock("@effect/sql-sqlite-bun", async () => ({
  SqliteClient: { layer: (await import("@effect/sql-sqlite-node")).SqliteClient.layer },
}));

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "backup-"));
  const directory = join(root, "nested", "snapshots");
  const server = join(root, "server.sqlite");
  const openCodeDatabase = join(root, "host.sqlite");
  for (const filename of [server, openCodeDatabase]) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE sample (value TEXT)`;
        yield* sql`INSERT INTO sample (value) VALUES (${filename})`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
    );
  }
  const alerts: string[] = [];
  const filesystem = FileSystem.layerNoop({
    makeDirectory: (path, options) => Effect.asVoid(Effect.promise(() => mkdir(path, options))),
    chmod: (path, mode) => Effect.promise(() => chmod(path, mode)),
    readDirectory: (path) => Effect.promise(() => readdir(path)),
    remove: (path) => Effect.promise(() => rm(path)),
  });
  const dependencies = Layer.merge(filesystem, SqliteClient.layer({ filename: server }));
  const health = {
    raise: (name: string, detail: string) =>
      Effect.sync(() => {
        alerts.push(`${name}: ${detail}`);
      }),
    clear: (name: string) =>
      Effect.sync(() => {
        alerts.push(`cleared: ${name}`);
      }),
  };
  return {
    directory,
    server,
    openCodeDatabase,
    alerts,
    health,
    dependencies,
    dispose: () => rm(root, { recursive: true, force: true }),
    missingHost: join(root, "missing", "host.sqlite"),
  };
};

test("nightly snapshots only the two persona databases and prunes files older than 14 days", async () => {
  const f = await fixture();
  const start = Date.parse("2026-09-25T17:59:00Z"); // 02:59 in Seoul
  try {
    await mkdir(f.directory, { recursive: true });
    await writeFile(join(f.directory, `server-${start - 15 * 86400000}.sqlite`), "old");
    await writeFile(join(f.directory, `server-${start + 60000 - 14 * 86400000}.sqlite`), "edge");
    await writeFile(join(f.directory, `opencode-${start - 13 * 86400000}.sqlite`), "recent");
    await writeFile(join(f.directory, "unrelated.txt"), "keep");
    await writeFile(join(f.directory, `extra-server-${start - 15 * 86400000}.sqlite`), "keep");
    await writeFile(join(f.directory, `server-${start - 15 * 86400000}.sqlite.bak`), "keep");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(start);
          const finished = yield* Deferred.make<void>();
          const backup = yield* makeBackup(
            { directory: f.directory, openCodeDatabase: f.openCodeDatabase },
            {
              ...f.health,
              clear: (name) =>
                f.health
                  .clear(name)
                  .pipe(Effect.andThen(Deferred.succeed(finished, undefined)), Effect.asVoid),
            },
          );
          yield* Effect.forkScoped(backup.monitor);
          yield* TestClock.adjust("1 millis");
          expect(yield* Effect.promise(() => readdir(f.directory))).not.toContain(
            `server-${start + 60000}.sqlite`,
          );
          yield* TestClock.adjust("59999 millis");
          yield* Deferred.await(finished);
        }),
      ).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    );
    const names = await readdir(f.directory);
    expect(names).toContain(`server-${start + 60000}.sqlite`);
    expect(names).toContain(`opencode-${start + 60000}.sqlite`);
    expect(names).not.toContain(`server-${start - 15 * 86400000}.sqlite`);
    expect(names).toContain(`server-${start + 60000 - 14 * 86400000}.sqlite`);
    expect(names).toContain(`opencode-${start - 13 * 86400000}.sqlite`);
    expect(names).toContain("unrelated.txt");
    expect(names).toContain(`extra-server-${start - 15 * 86400000}.sqlite`);
    expect(names).toContain(`server-${start - 15 * 86400000}.sqlite.bak`);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect(f.alerts).toEqual(["cleared: backup"]);
    const snapshot = async (name: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ value: string }>`SELECT value FROM sample`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename: join(f.directory, name) }))),
      );
    expect(await snapshot(`server-${start + 60000}.sqlite`)).toEqual([{ value: f.server }]);
    expect(await snapshot(`opencode-${start + 60000}.sqlite`)).toEqual([
      { value: f.openCodeDatabase },
    ]);
  } finally {
    await f.dispose();
  }
});

test("snapshot failures raise backup alerts; a later successful local snapshot clears them", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-26T00:00:00Z"));
        const broken = yield* makeBackup(
          { directory: f.directory, openCodeDatabase: f.missingHost },
          f.health,
        );
        yield* broken.tick;
        expect((yield* Effect.promise(() => stat(f.directory))).mode & 0o777).toBe(0o700);
        expect(f.alerts).toEqual(["backup: Backup failed"]);
        yield* TestClock.adjust("1 second");
        const backup = yield* makeBackup(
          { directory: f.directory, openCodeDatabase: f.openCodeDatabase },
          f.health,
        );
        yield* backup.tick;
        expect(f.alerts).toEqual(["backup: Backup failed", "cleared: backup"]);
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    );
  } finally {
    await f.dispose();
  }
});
