import { Clock, Deferred, Effect, Stream } from "effect";
import { observationFailure } from "./observe.ts";

interface Arrival {
  sessionID: string;
  messageID: string;
}

/** The in-process event bus emits only after durable admission. Context acknowledges exact IDs. */
export const localWait = <E>(events: Stream.Stream<Arrival, E>) =>
  Effect.gen(function* () {
    const unseen = new Map<string, Set<string>>();
    const observed = new Map<string, Set<string>>();
    const pending = new Map<string, Deferred.Deferred<void, Error>>();
    let unavailable = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unavailable = true;
        for (const signal of pending.values())
          Effect.runSync(Deferred.fail(signal, new Error("Local wait disposed")));
      }),
    );
    yield* Effect.forever(
      events.pipe(
        Stream.runForEach(({ sessionID, messageID }) =>
          Effect.gen(function* () {
            unavailable = false;
            if (observed.get(sessionID)?.has(messageID)) return;
            const ids = unseen.get(sessionID) ?? new Set<string>();
            ids.add(messageID);
            unseen.set(sessionID, ids);
            const signal = pending.get(sessionID);
            if (signal) yield* Deferred.succeed(signal, undefined);
          }),
        ),
        Effect.catch((cause) =>
          Effect.sync(() => {
            unavailable = true;
            observationFailure(cause, "events.subscribe", crypto.randomUUID(), performance.now());
            for (const signal of pending.values())
              Effect.runSync(
                Deferred.fail(signal, new Error("Local event subscription unavailable")),
              );
          }),
        ),
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ).pipe(Effect.forkScoped);
    return {
      observed: (sessionID: string, messageIDs: readonly string[]) => {
        observed.set(sessionID, new Set(messageIDs));
        for (const id of messageIDs) unseen.get(sessionID)?.delete(id);
      },
      wait: (sessionID: string, seconds: number) =>
        Effect.gen(function* () {
          if (unavailable)
            return yield* Effect.fail(new Error("Local event subscription unavailable"));
          const start = yield* Clock.currentTimeMillis;
          const duration = Math.min(Math.max(0, seconds), 3300);
          const signal = yield* Deferred.make<void, Error>();
          pending.set(sessionID, signal);
          const outcome = unseen.get(sessionID)?.size
            ? "new"
            : yield* Effect.raceFirst(
                Effect.sleep(duration * 1000).pipe(Effect.as("timeout")),
                Deferred.await(signal).pipe(Effect.as("new")),
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    pending.delete(sessionID);
                  }),
                ),
              );
          pending.delete(sessionID);
          const elapsed = Math.floor(((yield* Clock.currentTimeMillis) - start) / 1000);
          return outcome === "new"
            ? `paused ${elapsed}s, cut short by something new`
            : `paused ${duration}s`;
        }),
    };
  });
