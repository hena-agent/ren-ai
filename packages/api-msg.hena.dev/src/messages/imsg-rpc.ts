import { Deferred, Effect, Exit, Option, Queue, Scope, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { parseRpc } from "./imsg-protocol.ts";

type Frame = ReturnType<typeof parseRpc>;

/** One multiplexed child, shared by all callers; scope owns the child and its streams. */
export const imsgRpc = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const parent = yield* Scope.Scope;
  const notices = yield* Queue.make<Frame>();
  const gate = yield* Semaphore.make(1);
  let current: { scope: Scope.Closeable; input: Queue.Queue<Uint8Array> } | undefined;
  let sequence = 0;
  const pending = new Map<number, Deferred.Deferred<object, Error>>();
  const stop = Effect.gen(function* () {
    const old = current;
    current = undefined;
    const abandoned = [...pending.values()];
    for (const wait of abandoned) yield* Deferred.fail(wait, new Error("imsg RPC disconnected"));
    while (Option.isSome(yield* Queue.poll(notices))) {
      /* discard old subscription notifications */
    }
    if (old) {
      yield* Queue.shutdown(old.input);
      yield* Scope.close(old.scope, Exit.void);
    }
  });
  const start = Semaphore.withPermits(
    gate,
    1,
  )(
    Effect.gen(function* () {
      if (current) return current;
      const scope = yield* Scope.make();
      const child = yield* spawner
        .spawn(ChildProcess.make("imsg", ["rpc"], { stderr: "inherit" }))
        .pipe(Effect.provideService(Scope.Scope, scope));
      const input = yield* Queue.make<Uint8Array>();
      const connection = { scope, input };
      current = connection;
      yield* Stream.fromQueue(input).pipe(Stream.run(child.stdin), Effect.forkIn(scope));
      yield* child.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            const frame = yield* Effect.try(() => parseRpc(line));
            if ("id" in frame) {
              const wait = pending.get(frame.id);
              if (wait) {
                yield* frame.error
                  ? Deferred.fail(
                      wait,
                      new Error(`imsg ${frame.error.code}: ${frame.error.message}`),
                    )
                  : Deferred.succeed(wait, frame.result!);
              }
            } else yield* Queue.offer(notices, frame);
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            if (current !== connection) return;
            current = undefined;
            const abandoned = [...pending.values()];
            for (const wait of abandoned) yield* Deferred.fail(wait, new Error("imsg RPC exited"));
            yield* Queue.offer(notices, { method: "watch.disconnected", params: {} });
            // Closing our own scope here would wait for this reader fiber; delegate cleanup.
            yield* Effect.forkIn(Scope.close(scope, Exit.void), parent);
          }),
        ),
        Effect.forkIn(scope),
      );
      return connection;
    }),
  );
  yield* Scope.addFinalizer(parent, stop);
  const request = (method: string, params: object) =>
    Effect.gen(function* () {
      const connection = yield* start;
      const reply = yield* Deferred.make<object, Error>();
      if (pending.size >= 128) return yield* Effect.fail(new Error("imsg RPC capacity exceeded"));
      const id = ++sequence;
      pending.set(id, reply);
      try {
        yield* Queue.offer(
          connection.input,
          new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`),
        );
        return yield* Deferred.await(reply);
      } finally {
        pending.delete(id);
      }
    });
  return { request, notices, restart: stop };
});
