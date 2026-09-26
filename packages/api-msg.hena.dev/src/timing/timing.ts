import { Clock, Deferred, Effect } from "effect";

/** Each notification belongs to one Conversation; no other session is woken. */
export const timing = () => {
  const pending = new Map<number, Deferred.Deferred<void>>();
  const onNew = (id: number) => {
    const signal = pending.get(id);
    pending.delete(id);
    if (signal) Effect.runSync(Deferred.succeed(signal, undefined));
  };
  const during = <A, E, R>(id: number, action: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let signal = pending.get(id);
      if (!signal) {
        signal = yield* Deferred.make<void>();
        pending.set(id, signal);
      }
      const result = yield* Effect.race(action, Effect.as(Deferred.await(signal), "new" as const));
      return (yield* Deferred.isDone(signal)) ? "new" : result;
    });
  const wait = (id: number, minutes: number) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const outcome = yield* during(id, Effect.sleep(Math.min(minutes, 720) * 60_000));
      const seconds = Math.floor(((yield* Clock.currentTimeMillis) - start) / 1000);
      return outcome === "new"
        ? `paused ${seconds}s, cut short by something new`
        : `paused ${Math.min(minutes, 720)}m`;
    });
  return { onNew, during, wait };
};
