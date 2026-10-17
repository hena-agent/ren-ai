import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, PlatformError, Queue, Schema, Scope, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";
import type { BridgeMessage } from "../src/messages/bridge-protocol.ts";
import { makeRustpushMessages } from "../src/messages/rustpush.ts";

export const service = "mailto:hi@renai.im";

const request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    requestId: Schema.String,
    method: Schema.String,
    params: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
  }),
);
type Request = typeof request.Type;

type Answer = object | "hang" | "exit";

const ioFailure = (code: "ENOENT" | "EPIPE") =>
  PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : "Unknown",
    module: "ChildProcess",
    method: "io",
    pathOrDescriptor: "/private/apple-state/secret",
    cause: Object.assign(new Error("private spawn input"), { code }),
  });

/** A scripted `ren-rustpush rpc`: answers requests, emits events and records acknowledgements. */
export const bridgeFixture = (handles: ReadonlyArray<string> = [service]) => {
  const requests: Request[] = [];
  const spawned: Array<{ command: string; args: ReadonlyArray<string>; env: object }> = [];
  const acknowledged: string[] = [];
  const answers = new Map<string, Answer[]>();
  let processes: Array<{ write: (text: string) => void; exit: () => void }> = [];
  let spawnFailures = 0;
  let writeFailures = 0;
  let silentStart = false;
  let spool = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Unexpected pipeline");
      if (spawnFailures > 0) {
        spawnFailures--;
        return yield* Effect.fail(ioFailure("ENOENT"));
      }
      spawned.push({
        command: command.command,
        args: command.args,
        env: command.options.env ?? {},
      });
      const output = yield* Queue.make<Uint8Array>();
      const write = (text: string) =>
        Queue.offerUnsafe(output, new TextEncoder().encode(`${text}\n`));
      const emit = (value: object) => write(JSON.stringify(value));
      const process = { write, exit: () => Effect.runFork(Queue.shutdown(output)) };
      processes.push(process);
      yield* Effect.addFinalizer(() => Effect.sync(() => process.exit()));
      const respond = (line: string) => {
        const parsed = Schema.decodeUnknownSync(request)(line);
        requests.push(parsed);
        if (parsed.method === "ack") acknowledged.push(String(parsed.params["spool"]));
        if (parsed.method === "handles" && silentStart) return;
        respondWith(parsed);
      };
      const respondWith = (parsed: Request) => {
        const answer =
          answers.get(parsed.method)?.shift() ??
          (parsed.method === "handles"
            ? { handles }
            : parsed.method === "ack"
              ? { acknowledged: true }
              : { status: "sent" });
        if (answer === "exit") process.exit();
        else if (answer !== "hang")
          emit({
            id: parsed.id,
            ...("stage" in answer
              ? { error: { ...answer, requestId: parsed.requestId } }
              : { result: answer }),
          });
      };
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(processes.length),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.sync(() => process.exit()),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            if (writeFailures > 0) {
              writeFailures--;
              return yield* Effect.fail(ioFailure("EPIPE"));
            }
            for (const line of new TextDecoder().decode(bytes).split("\n").filter(Boolean))
              respond(line);
          }),
        ),
        getInputFd: () => Sink.drain,
        stdout: Stream.fromQueue(output),
        getOutputFd: () => Stream.empty,
        stderr: Stream.empty,
        unref: Effect.succeed(Effect.void),
        all: Stream.empty,
      });
    }),
  );
  return {
    requests,
    spawned,
    acknowledged,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    /** Queue answers for the next requests of a method: a result, an error, "hang" or "exit". */
    answer: (method: string, ...next: Answer[]) =>
      answers.set(method, [...(answers.get(method) ?? []), ...next]),
    failSpawns: (count: number) => (spawnFailures = count),
    failWrites: (count: number) => (writeFailures = count),
    holdStart: (hold: boolean) => (silentStart = hold),
    /** The bridge's next notification for the gateway; returns its spool name. */
    deliver: (message: BridgeMessage) => {
      const name = `inbox-${++spool}.plist`;
      processes.at(-1)?.write(JSON.stringify({ event: "message", spool: name, message }));
      return name;
    },
    raw: (line: string) => processes.at(-1)?.write(line),
    exit: () => {
      processes.at(-1)?.exit();
      processes = processes.slice(0, -1);
    },
    running: () => processes.length,
  };
};

/** A text from the other person, as the bridge reports it. */
export const incoming = (
  from: string,
  text: string,
  sentAt: number,
  extra: Partial<Extract<BridgeMessage, { kind: "text" }>> = {},
): BridgeMessage => ({
  guid: crypto.randomUUID().toUpperCase(),
  sender: from,
  participants: [from, service],
  sentAt,
  kind: "text",
  text,
  attachments: [],
  replyTo: null,
  payload: null,
  ...extra,
});

const directories: string[] = [];

export const cleanup = () => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
};

/** The real adapter over a scripted bridge, started and ready. */
export const rustpushFixture = (bridge = bridgeFixture(), settleMillis = 1_000) => {
  const directory = mkdtempSync(join(tmpdir(), "imsg-rustpush-"));
  directories.push(directory);
  const alerts: string[] = [];
  const run = <A, E>(
    story: (
      adapter: Effect.Success<ReturnType<typeof makeRustpushMessages>>,
    ) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const made = yield* makeRustpushMessages(
            {
              command: "ren-rustpush",
              state: join(directory, "rustpush"),
              history: join(directory, "history.sqlite"),
              handle: "hi@renai.im",
              settleMillis,
              restartMillis: 1,
            },
            {
              raise: (name) => Effect.sync(() => alerts.push(`raise:${name}`)),
              clear: (name) => Effect.sync(() => alerts.push(`clear:${name}`)),
            },
          );
          yield* Effect.promise(() =>
            vi.waitFor(() => Effect.runPromise(made.gestures.probe()), { timeout: 2_000 }),
          );
          return yield* story(made);
        }),
      ).pipe(Effect.provide(bridge.layer)),
    );
  return { bridge, alerts, run, directory };
};
