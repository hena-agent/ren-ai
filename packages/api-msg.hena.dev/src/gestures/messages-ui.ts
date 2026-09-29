import { fileURLToPath } from "node:url";
import { Effect, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Gestures } from "./gestures.ts";

const script = fileURLToPath(new URL("./messages-ui.applescript", import.meta.url));
const url = (handle: string) => `sms://open?groupid=${encodeURIComponent(handle)}`;

// imsg chats prints one JSON object per line, not a JSON array.
const chatFor = (output: string, handle: string) => {
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parse untrusted imsg chat JSON
    const row: unknown = JSON.parse(line);
    if (typeof row !== "object" || row === null) continue;
    if (!("identifier" in row) || row.identifier !== handle) continue;
    if (!("service" in row) || row.service !== "iMessage") continue;
    if (!("is_group" in row) || row.is_group !== false) continue;
    if (!("id" in row) || !Number.isSafeInteger(row.id) || Number(row.id) <= 0) continue;
    return Number(row.id);
  }
  throw new Error(`No direct iMessage Conversation for ${handle}`);
};

export const makeMessagesUi = (health: {
  readonly raise: (name: string, detail: string) => Effect.Effect<void>;
  readonly clear: (name: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lock = yield* Semaphore.make(1);
    let failures = 0;

    // osascript and imsg report failure by exit status and stderr, never on stdout. The spawner's
    // own `string` ignores the status, so a guard that fails would look like success.
    const capture = (command: ChildProcess.Command) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* processes.spawn(command);
          const [stdout, stderr, code] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(child.stdout)),
              Stream.mkString(Stream.decodeText(child.stderr)),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code !== 0)
            return yield* Effect.fail(new Error(`exit code ${code}: ${stderr.trim()}`));
          return stdout;
        }),
      );
    const run = (action: string, ...args: string[]) =>
      capture(
        ChildProcess.make("/usr/bin/osascript", [script, action, ...args], {
          forceKillAfter: "1 second",
        }),
      ).pipe(
        Effect.mapError((error) => new Error(`Messages UI ${action}: ${error.message}`)),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new Error(`Messages UI ${action} timed out`)),
        }),
      );
    const find = (handle: string) =>
      capture(ChildProcess.make("imsg", ["chats", "--limit", "10000", "--json"])).pipe(
        Effect.flatMap((output) =>
          Effect.try({
            try: () => chatFor(output, handle),
            catch: (error) => new Error(String(error)),
          }),
        ),
        Effect.mapError((error) => new Error(`Cannot find Conversation: ${String(error)}`)),
      );
    const alert = (action: string, error: Error) =>
      Effect.gen(function* () {
        failures++;
        const detail = `${action}: ${error.message}`;
        if (failures >= 3) yield* health.raise("gestures", detail);
        // The reply goes out anyway, so a typing that cannot show is reported at once.
        if (action === "typing") yield* health.raise("typing", detail);
        if (action === "ensure") yield* health.raise("messages-window", error.message);
      });
    // Only a working typing clears its own alert: a read in the same turn must not.
    const success = (action: string) =>
      Effect.gen(function* () {
        failures = 0;
        yield* health.clear("gestures");
        yield* health.clear("messages-window");
        if (action === "typing") yield* health.clear("typing");
      });
    const act = <A>(action: string, body: Effect.Effect<A, Error>) =>
      Effect.gen(function* () {
        yield* run("ensure").pipe(Effect.tapError((error) => alert("ensure", error)));
        return yield* body;
      }).pipe(
        Effect.onExit(() =>
          run("park").pipe(
            Effect.asVoid,
            Effect.tapError((error) => alert("park", error)),
          ),
        ),
        Effect.tap(() => success(action)),
        Effect.tapError((error) => alert(action, error)),
      );

    const gestures: Gestures = {
      typing: (handle, text, durationMillis) =>
        Effect.gen(function* () {
          const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          return yield* lock.withPermit(
            act(
              "typing",
              Effect.gen(function* () {
                yield* find(handle);
                yield* run("open", url(handle));
                // A previous interrupted turn may have left a draft, even across a restart.
                yield* run("clear", url(handle));
                // Always clear the draft, including on an interrupted Effect.
                yield* Effect.gen(function* () {
                  for (const character of text) {
                    yield* run("key", character);
                  }
                  const elapsed =
                    (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) - started;
                  yield* Effect.sleep(Math.max(0, durationMillis - elapsed));
                }).pipe(Effect.onExit(() => run("clear", url(handle)).pipe(Effect.asVoid)));
                return true;
              }),
            ),
          );
        }),
      read: (handle) =>
        lock.withPermit(
          act(
            "read",
            Effect.gen(function* () {
              yield* find(handle);
              yield* run("read", url(handle));
            }),
          ),
        ),
      react: (handle, tapback) =>
        lock.withPermit(
          act(
            "react",
            Effect.gen(function* () {
              const chat = yield* find(handle);
              yield* capture(
                ChildProcess.make("imsg", [
                  "react",
                  "--chat-id",
                  String(chat),
                  "--reaction",
                  tapback,
                  "--json",
                ]),
              ).pipe(Effect.mapError((error) => new Error(`Tapback failed: ${error.message}`)));
            }),
          ),
        ),
    };
    return gestures;
  });
