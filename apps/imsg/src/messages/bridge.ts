import { Clock, Data, Deferred, Effect, Exit, Fiber, Queue, Scope, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { parseFrame, type BridgeMessage, type BridgeResult } from "./bridge-protocol.ts";
import { observe } from "../diagnostics.ts";

/** The request was never written to a ready bridge: nothing was submitted. */
export class BridgeUnavailable extends Data.TaggedError("BridgeUnavailable")<{
  readonly message: string;
}> {}

/** The bridge answered with an error; input-stage errors mean nothing was submitted. */
export class BridgeRejected extends Data.TaggedError("BridgeRejected")<{
  readonly message: string;
  readonly stage: string;
  readonly code: string;
  readonly requestId: string;
}> {}

/** The bridge exited after receiving the request: its outcome is uncertain. */
class BridgeLost extends Data.TaggedError("BridgeLost")<{ readonly message: string }> {}

export type BridgeError = BridgeUnavailable | BridgeRejected | BridgeLost;

export interface Alerts {
  raise(name: string, detail: string): Effect.Effect<void>;
  clear(name: string): Effect.Effect<void>;
}

type Pending = Deferred.Deferred<BridgeResult, BridgeRejected | BridgeLost>;

export interface BridgeOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** First restart delay; doubles to 30 seconds while the bridge keeps exiting quickly. */
  readonly restartMillis?: number;
  /** A bridge that ran at least this long was healthy: its exit resets the restart delay. */
  readonly healthyMillis?: number;
  /** Includes Apple session restoration; expiry restarts the bridge, leaving sends in doubt. */
  readonly requestMillis?: number;
}

const log = (level: "info" | "error", fields: Record<string, string | number>) =>
  (level === "info" ? Effect.logInfo : Effect.logError)({
    service: "imsg",
    operation: "rustpush.bridge",
    ...fields,
  });

/**
 * Keeps one native bridge running for as long as the scope lives. Each event is acknowledged
 * only after `receive` succeeds, so until then the bridge keeps it spooled and re-sends it.
 */
export const startBridge = (
  options: BridgeOptions,
  receive: (message: BridgeMessage) => Effect.Effect<void, Error>,
  alerts: Alerts,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lifetime = yield* Scope.Scope;
    const pending = new Map<number, Pending>();
    let connection:
      | {
          readonly input: Queue.Queue<Uint8Array>;
          readonly kill: Effect.Effect<void>;
          ready: boolean;
        }
      | undefined;
    let sequence = 0;
    // Synchronous, so a closing bridge either sees this request as pending or refuses it.
    const write = (method: string, params: object, requireReady = true, requestId = randomUUID()) =>
      Effect.suspend((): Effect.Effect<BridgeResult, BridgeError> => {
        if (!connection || (requireReady && !connection.ready))
          return Effect.fail(new BridgeUnavailable({ message: "Messaging bridge is not running" }));
        const id = ++sequence;
        const active = connection;
        const reply: Pending = Deferred.makeUnsafe();
        pending.set(id, reply);
        Queue.offerUnsafe(
          connection.input,
          new TextEncoder().encode(`${JSON.stringify({ id, method, params, requestId })}\n`),
        );
        return Deferred.await(reply).pipe(
          Effect.timeoutOrElse({
            duration: options.requestMillis ?? 125_000,
            orElse: () =>
              log("error", { stage: "request.timeout", requestId, outcome: "uncertain" }).pipe(
                Effect.andThen(active.kill),
                Effect.andThen(
                  Effect.fail(
                    new BridgeLost({ message: "Messaging bridge timed out; outcome uncertain" }),
                  ),
                ),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      });
    const call = (method: string, params: object) =>
      // Restored notifications can arrive before the handles handshake completes.
      Effect.suspend(() => {
        const requestId = randomUUID();
        return observe(
          `rustpush.rpc.${method}`,
          write(method, params, method !== "ack", requestId),
          () => ({
            pending: pending.size,
          }),
          requestId,
        );
      });
    const dispatch = (line: string) =>
      Effect.gen(function* () {
        const frame = yield* Effect.try(() => parseFrame(line));
        if ("event" in frame) {
          // Unacknowledged events stay spooled in the bridge, which re-sends them.
          const acknowledge = observe(
            "rustpush.event.apply",
            receive(frame.message),
            () => ({}),
          ).pipe(Effect.andThen(call("ack", { spool: frame.spool })), Effect.ignore);
          yield* Effect.forkIn(acknowledge, lifetime);
          return;
        }
        const wait = pending.get(frame.id);
        if (!wait) return;
        if ("result" in frame) {
          yield* Deferred.succeed(wait, frame.result);
          return;
        }
        const { stage, cause: detail, requestId } = frame.error;
        const code = String(detail["code"] ?? detail["kind"] ?? "unknown");
        yield* Deferred.fail(
          wait,
          new BridgeRejected({
            message: `Messaging bridge rejected the request at ${stage} (request ${requestId})`,
            stage,
            code,
            requestId,
          }),
        );
      }).pipe(Effect.catch(() => log("error", { stage: "frame.decode", cause: "invalid_frame" })));
    const run = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(options.command, options.args, {
            env: options.env,
            extendEnv: true,
            stderr: "inherit",
          }),
        );
        const current = {
          input: yield* Queue.make<Uint8Array>(),
          kill: child.kill().pipe(Effect.ignore),
          ready: false,
        };
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            connection = undefined;
            const lost = new BridgeLost({ message: "Messaging bridge exited; outcome uncertain" });
            yield* Effect.forEach([...pending.values()], (wait) => Deferred.fail(wait, lost));
            yield* Queue.shutdown(current.input);
          }),
        );
        connection = current;
        const writer = yield* Stream.fromQueue(current.input).pipe(
          Stream.run(child.stdin),
          Effect.forkScoped,
        );
        const lines = yield* child.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach(dispatch),
          Effect.forkScoped,
        );
        // The bridge answers only once its Apple session is restored; requests wait for that.
        const handshakeId = randomUUID();
        yield* observe(
          "rustpush.handshake",
          write("handles", {}, false, handshakeId),
          () => ({}),
          handshakeId,
        ).pipe(
          Effect.andThen(Effect.sync(() => (current.ready = true))),
          Effect.andThen(log("info", { stage: "bridge.start", outcome: "ready" })),
          Effect.andThen(alerts.clear("rustpush-bridge")),
          Effect.catch(() => current.kill),
          Effect.forkScoped,
        );
        yield* Effect.raceFirst(Fiber.join(lines), Fiber.join(writer));
      }),
    );
    const restart = options.restartMillis ?? 1000;
    const healthy = options.healthyMillis ?? 60_000;
    const supervise = Effect.gen(function* () {
      let delay = restart;
      let failures = 0;
      for (;;) {
        const requestId = randomUUID();
        const started = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(observe("rustpush.process", run, () => ({}), requestId));
        const durationMs = (yield* Clock.currentTimeMillis) - started;
        const quick = durationMs < healthy;
        failures = quick ? failures + 1 : 1;
        delay = quick ? Math.min(delay * 2, 30_000) : restart;
        yield* log("error", {
          stage: "bridge.exit",
          requestId,
          durationMs,
          outcome: Exit.isSuccess(exit) ? "exited" : "spawn_failed",
          restartMillis: delay,
        });
        if (failures >= 3) yield* alerts.raise("rustpush-bridge", "Messaging bridge keeps exiting");
        yield* Effect.sleep(delay);
      }
    });
    yield* Effect.forkIn(supervise, lifetime);
    return { call };
  });
