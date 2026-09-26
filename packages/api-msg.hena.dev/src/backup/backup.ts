import { Clock, Config, Cron, Effect, FileSystem, Result, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const retention = 14 * 24 * 60 * 60 * 1000;

interface BackupOptions {
  readonly directory: string;
  readonly openCodeDatabase: string;
  readonly bucket: string;
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
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const accessKey = yield* Config.string("R2_ACCESS_KEY_ID");
    const secretKey = yield* Config.string("R2_SECRET_ACCESS_KEY");
    const endpoint = yield* Config.string("R2_ENDPOINT");
    const backupKey = yield* Config.string("BACKUP_KEY");
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

      // rclone's crypt password must be obscured. Feed it through stdin, never argv or a config file.
      const obscured = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* processes.spawn(
            ChildProcess.make("rclone", ["obscure", "-"], {
              stdin: Stream.make(new TextEncoder().encode(`${backupKey}\n`)),
            }),
          );
          const output = yield* Stream.mkString(Stream.decodeText(handle.stdout));
          if ((yield* handle.exitCode) !== 0) return yield* Effect.fail(new Error());
          return output.trim();
        }),
      );
      const code = yield* processes.exitCode(
        ChildProcess.make(
          "rclone",
          [
            "sync",
            "--config",
            "/dev/null",
            "--include",
            "server-*.sqlite",
            "--include",
            "opencode-*.sqlite",
            options.directory,
            "encrypted:",
          ],
          {
            extendEnv: true,
            env: {
              RCLONE_CONFIG_R2_TYPE: "s3",
              RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
              RCLONE_CONFIG_R2_ACCESS_KEY_ID: accessKey,
              RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: secretKey,
              RCLONE_CONFIG_R2_ENDPOINT: endpoint,
              RCLONE_CONFIG_ENCRYPTED_TYPE: "crypt",
              RCLONE_CONFIG_ENCRYPTED_REMOTE: `r2:${options.bucket}/persona-snapshots`,
              RCLONE_CONFIG_ENCRYPTED_PASSWORD: obscured,
            },
          },
        ),
      );
      if (code !== 0) yield* Effect.fail(new Error());
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
