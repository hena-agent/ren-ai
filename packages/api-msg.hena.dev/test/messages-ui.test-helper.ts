import { Effect, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import { makeMessagesUi } from "../src/gestures/messages-ui.ts";

const text = (content: string) => Stream.make(new TextEncoder().encode(content));

/** The error message an Effect fails with; the Effect failing to fail is the test failing. */
export const failure = <A>(effect: Effect.Effect<A, Error>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message);

export const setup = async () => {
  const events: string[] = [];
  const alerts: string[] = [];
  let fail = "";
  let exiting = "";
  let diagnostic = "";
  let keyPause: Effect.Effect<void> = Effect.void;
  let chats = '{"id":42,"identifier":"alice@example.com","service":"iMessage","is_group":false}\n';
  let block: Effect.Effect<void> = Effect.void;
  let blockedAction = "";
  let blockedFor: Effect.Effect<void> = Effect.void;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) throw Error("Unexpected pipeline");
      if (command.command !== "imsg") {
        expect(command.command).toBe("/usr/bin/osascript");
        expect(command.args[0]).toMatch(/\/messages-ui\.applescript$/);
        expect(command.options.forceKillAfter).toBe("1 second");
      }
      const [first = "", second = ""] = command.args;
      const action = command.command === "imsg" ? first : second;
      events.push(
        `${action} ${command.args.slice(command.command === "imsg" ? 1 : 2).join(" ")}`.trim(),
      );
      if (action === fail)
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "test",
            method: action,
            description: `${action} failed`,
          }),
        );
      if (action === "react") yield* block;
      if (action === "key") yield* keyPause;
      if (action === blockedAction) yield* blockedFor;
      // Like osascript and imsg: nothing on stdout, the reason on stderr, exit status 1.
      const exits = action === exiting;
      return ChildProcessSpawner.makeHandle({
        stdout: exits ? Stream.empty : text(action === "chats" ? chats : "ok"),
        stderr: exits ? text(`${diagnostic}\n`) : Stream.empty,
        all: Stream.empty,
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exits ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const gestures = await Effect.runPromise(
    makeMessagesUi({
      raise: (name, detail) =>
        Effect.sync(() => {
          alerts.push(`${name}: ${detail}`);
        }),
      clear: (name) =>
        Effect.sync(() => {
          alerts.push(`clear: ${name}`);
        }),
    }).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
  );
  return {
    gestures,
    events,
    alerts,
    failOn: (action: string) => {
      fail = action;
    },
    exitOn: (action: string, stderr: string) => {
      exiting = action;
      diagnostic = stderr;
    },
    pauseKey: (effect: Effect.Effect<void>) => {
      keyPause = effect;
    },
    setChats: (output: string) => {
      chats = output;
    },
    blockReact: (effect: Effect.Effect<void>) => {
      block = effect;
    },
    blockAction: (action: string, effect: Effect.Effect<void>) => {
      blockedAction = action;
      blockedFor = effect;
    },
  };
};
