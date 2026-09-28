import { Clock, Cron, Effect, FileSystem, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";

const retention = 14 * 24 * 60 * 60 * 1000;

interface BackupOptions {
  readonly directory: string;
  readonly openCodeDatabase: string;
}

/** Requires the server's SqlClient; opens the embedded host's file only during a snapshot. */
export const makeBackup = (
  options: BackupOptions,
  health: {
    readonly raise: (name: string, detail: string) => Effect.Effect<void>;
    readonly clear: (name: string) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const nightly = Result.getOrThrow(Cron.parse("0 3 * * *", "Asia/Seoul"));

    const run = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* fs.makeDirectory(options.directory, { recursive: true, mode: 0o700 });
      yield* fs.chmod(options.directory, 0o700);
      yield* sql`VACUUM INTO ${`${options.directory}/server-${now}.sqlite`}`;
      const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"));
      yield* Effect.gen(function* () {
        const hostSql = yield* SqlClient.SqlClient;
        yield* hostSql`VACUUM INTO ${`${options.directory}/opencode-${now}.sqlite`}`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: options.openCodeDatabase })));

      for (const file of yield* fs.readDirectory(options.directory)) {
        const match = /^(?:server|opencode)-(\d+)\.sqlite$/.exec(file);
        if (match && Number(match[1]) < now - retention) {
          yield* fs.remove(`${options.directory}/${file}`);
        }
      }
    });

    const tick = run.pipe(
      Effect.andThen(health.clear("backup")),
      Effect.catchCause(() => health.raise("backup", "Backup failed")),
    );
    const monitor = Effect.forever(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Cron.next(nightly, new Date(now)).getTime() - now);
        yield* tick;
      }),
    );
    return { tick, monitor };
  });
