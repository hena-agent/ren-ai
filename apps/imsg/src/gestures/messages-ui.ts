import { fileURLToPath } from "node:url";
import { Clock, Effect, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { Gestures } from "./gestures.ts";
import { observe } from "../diagnostics.ts";
import { chatLookup } from "./chat-lookup.ts";

const script = fileURLToPath(new URL("./messages-ui.applescript", import.meta.url));
const url = (handle: string) => `sms://open?groupid=${encodeURIComponent(handle)}`;

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
        Effect.mapError(
          (error) => new Error(`Messages UI ${action}: ${error.message}`, { cause: error }),
        ),
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new Error(`Messages UI ${action} timed out`)),
        }),
      );
    const find = chatLookup(capture);
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

    let queued = 0;
    const locked = <A>(action: string, body: Effect.Effect<A, Error>) =>
      Effect.gen(function* () {
        const enqueued = yield* Clock.currentTimeMillis;
        queued++;
        let queueWaitMs = 0;
        return yield* observe(
          `imsg.gesture.${action}`,
          lock
            .withPermit(
              Effect.gen(function* () {
                queueWaitMs = (yield* Clock.currentTimeMillis) - enqueued;
                return yield* body;
              }),
            )
            .pipe(Effect.timeout("60 seconds")),
          () => ({ queueWaitMs, queued }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              queued--;
            }),
          ),
        );
      });
    const gestures: Gestures = {
      probe: () => locked("probe", act("ensure", Effect.void)),
      typing: (handle, text, durationMillis) =>
        Effect.gen(function* () {
          const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          return yield* locked(
            "typing",
            act(
              "typing",
              Effect.gen(function* () {
                yield* find(handle);
                yield* run("open", url(handle));
                // A previous interrupted turn may have left a draft, even across a restart.
                yield* run("clear", url(handle));
                // Always clear the draft, including on an interrupted Effect.
                yield* Effect.gen(function* () {
                  yield* run("key", text);
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
        locked(
          "read",
          act(
            "read",
            Effect.gen(function* () {
              yield* find(handle);
              yield* run("read", url(handle));
            }),
          ),
        ),
      react: (handle, tapback) =>
        locked(
          "react",
          act(
            "react",
            Effect.gen(function* () {
              const chat = yield* find(handle);
              yield* capture(
                ChildProcess.make(
                  "imsg",
                  ["react", "--chat-id", String(chat), "--reaction", tapback, "--json"],
                  { forceKillAfter: "1 second" },
                ),
              ).pipe(
                Effect.timeout("15 seconds"),
                Effect.mapError(
                  (error) => new Error(`Tapback failed: ${error.message}`, { cause: error }),
                ),
              );
            }),
          ),
        ),
    };
    return gestures;
  });
