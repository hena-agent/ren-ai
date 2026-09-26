import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { ConfigProvider, Deferred, Effect, FileSystem, Layer, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
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
  const commands: ChildProcess.StandardCommand[] = [];
  const inputs: string[] = [];
  const alerts: string[] = [];
  let obscureStatus = 0;
  let copyStatus = 0;
  const processes = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) throw Error("unexpected pipeline");
      commands.push(command);
      if (Stream.isStream(command.options.stdin)) {
        const bytes = yield* Stream.runCollect(command.options.stdin);
        inputs.push(new TextDecoder().decode(bytes[0]));
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(
          ChildProcessSpawner.ExitCode(command.args[0] === "obscure" ? obscureStatus : copyStatus),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("obscured-secret\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const filesystem = FileSystem.layerNoop({
    makeDirectory: (path, options) => Effect.asVoid(Effect.promise(() => mkdir(path, options))),
    chmod: (path, mode) => Effect.promise(() => chmod(path, mode)),
    readDirectory: (path) => Effect.promise(() => readdir(path)),
    remove: (path) => Effect.promise(() => rm(path)),
  });
  const dependencies = Layer.mergeAll(
    filesystem,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, processes),
    SqliteClient.layer({ filename: server }),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        R2_ACCESS_KEY_ID: "access",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_ENDPOINT: "https://r2.example",
        BACKUP_KEY: "private password",
      }),
    ),
  );
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
    commands,
    inputs,
    alerts,
    health,
    dependencies,
    dispose: () => rm(root, { recursive: true, force: true }),
    setObscureStatus: (status: number) => {
      obscureStatus = status;
    },
    setCopyStatus: (status: number) => {
      copyStatus = status;
    },
    missingHost: join(root, "missing", "host.sqlite"),
  };
};

test("nightly snapshots both databases, prunes old copies, and uploads through crypt", async () => {
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
            {
              directory: f.directory,
              openCodeDatabase: f.openCodeDatabase,
              bucket: "persona-backups",
            },
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
          expect(f.commands).toHaveLength(0);
          yield* TestClock.adjust("59999 millis");
          yield* Deferred.await(finished);
          expect(f.commands).toHaveLength(2);
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
    const [obscure, copy] = f.commands;
    expect(obscure?.command).toBe("rclone");
    expect(obscure?.args).toEqual(["obscure", "-"]);
    expect(obscure?.options.stdin).toBeDefined();
    expect(f.inputs).toEqual(["private password\n"]);
    expect(copy?.command).toBe("rclone");
    expect(copy?.args).toEqual([
      "sync",
      "--config",
      "/dev/null",
      "--include",
      "server-*.sqlite",
      "--include",
      "opencode-*.sqlite",
      f.directory,
      "encrypted:",
    ]);
    expect(copy?.options.extendEnv).toBe(true);
    expect(copy?.options.env).toEqual({
      RCLONE_CONFIG_R2_TYPE: "s3",
      RCLONE_CONFIG_R2_PROVIDER: "Cloudflare",
      RCLONE_CONFIG_R2_ACCESS_KEY_ID: "access",
      RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: "secret",
      RCLONE_CONFIG_R2_ENDPOINT: "https://r2.example",
      RCLONE_CONFIG_ENCRYPTED_TYPE: "crypt",
      RCLONE_CONFIG_ENCRYPTED_REMOTE: "r2:persona-backups/persona-snapshots",
      RCLONE_CONFIG_ENCRYPTED_PASSWORD: "obscured-secret",
    });
    expect(JSON.stringify(f.commands)).not.toContain("private password");
    expect(await readFile(join(f.directory, "unrelated.txt"), "utf8")).toBe("keep");
  } finally {
    await f.dispose();
  }
});

test("failed snapshots and rclone steps alert, and success clears the alert", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-26T00:00:00Z"));
        const backup = yield* makeBackup(
          {
            directory: f.directory,
            openCodeDatabase: f.openCodeDatabase,
            bucket: "persona-backups",
          },
          f.health,
        );
        f.setObscureStatus(1);
        yield* backup.tick;
        expect((yield* Effect.promise(() => stat(f.directory))).mode & 0o777).toBe(0o700);
        expect(f.alerts).toEqual(["backup: Backup failed"]);
        f.setObscureStatus(0);
        f.setCopyStatus(2);
        yield* TestClock.adjust("1 second");
        yield* backup.tick;
        expect(f.alerts).toEqual(["backup: Backup failed", "backup: Backup failed"]);
        f.setCopyStatus(0);
        yield* TestClock.adjust("1 second");
        yield* backup.tick;
        expect(f.alerts.at(-1)).toBe("cleared: backup");
        const broken = yield* makeBackup(
          {
            directory: f.directory,
            openCodeDatabase: f.missingHost,
            bucket: "persona-backups",
          },
          f.health,
        );
        yield* TestClock.adjust("1 second");
        yield* broken.tick;
        expect(f.alerts.at(-1)).toBe("backup: Backup failed");
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    );
  } finally {
    await f.dispose();
  }
});
