import { SessionEvent } from "@opencode/schema/session-event";
import { Session } from "@opencode/schema/session";
import { Effect, Option, Stream, type Fiber } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { createHost } from "./host.ts";
import type { conversations } from "../conversations/conversations.ts";

type Host = Effect.Success<ReturnType<typeof createHost>>;
type Directory = Effect.Success<typeof conversations>;

export interface FailureAlerts {
  readonly raise: (name: string, detail?: string) => Effect.Effect<void>;
  readonly clear: (name: string) => Effect.Effect<void>;
}

const cap = "go-cap";
const provider = "provider-failing";
const turnAlert = (id: string) => `conversation-turn-failing:${id}`;
const interval = "15 minutes";

/** OpenCode owns the durable outcome; this scheduler owns only live delays. */
export const failedTurns = (host: Host, directory: Directory, alerts: FailureAlerts) =>
  Effect.gen(function* () {
    const pending = new Map<
      string,
      {
        count: number;
        quota: boolean;
        retry?: Fiber.Fiber<void, SqlError>;
      }
    >();
    let capTimer: Fiber.Fiber<never, SqlError> | undefined;
    let providerTimer: Fiber.Fiber<void> | undefined;
    let nextQuota = 0;

    const resume = (id: string) =>
      Effect.gen(function* () {
        if (!(yield* directory.bySession(id))) return;
        yield* host.sessions.resume(Session.ID.make(id)).pipe(Effect.catchCause(Effect.logWarning));
      });

    const quotaIDs = () => [...pending].filter(([, state]) => state.quota).map(([id]) => id);
    const hasProviderFailure = () => [...pending.values()].some((state) => !state.quota);

    const onFailed = (event: SessionEvent.Execution.Failed) =>
      Effect.gen(function* () {
        const id = event.data.sessionID;
        if (!(yield* directory.bySession(id))) return;
        const quota = /quota/i.test(event.data.error.type) || quotaIDs().length > 0;
        const previous = pending.get(id);
        const count = (previous?.count ?? 0) + 1;
        const firstProviderFailure = !hasProviderFailure();
        const firstQuotaFailure = quotaIDs().length === 0;
        previous?.retry?.interruptUnsafe();
        const current: { count: number; quota: boolean; retry?: Fiber.Fiber<void, SqlError> } = {
          count,
          quota,
        };
        pending.set(id, current);
        if (count === 3) yield* alerts.raise(turnAlert(id), "A Conversation's turn keeps failing");
        if (quota) {
          if (!firstQuotaFailure) return;
          for (const state of pending.values()) {
            state.quota = true;
            state.retry?.interruptUnsafe();
          }
          providerTimer?.interruptUnsafe();
          providerTimer = undefined;
          yield* alerts.clear(provider);
          yield* alerts.raise(cap, "OpenCode Go cap reached");
          capTimer = yield* Effect.forever(
            Effect.sleep(interval).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  const ids = quotaIDs();
                  return resume(ids[nextQuota++ % ids.length]!);
                }),
              ),
            ),
          ).pipe(Effect.forkScoped);
          return;
        }
        if (firstProviderFailure) {
          providerTimer = yield* Effect.sleep("10 minutes").pipe(
            Effect.andThen(alerts.raise(provider, "Provider failing for 10 minutes")),
            Effect.forkScoped,
          );
        }
        current.retry = yield* Effect.sleep(`${Math.min(2 ** (count - 1), 900)} seconds`).pipe(
          Effect.andThen(resume(id)),
          Effect.forkScoped,
        );
      });

    const onSucceeded = (id: string) =>
      Effect.gen(function* () {
        const wasQuota = quotaIDs().length > 0;
        pending.get(id)?.retry?.interruptUnsafe();
        pending.delete(id);
        const held = quotaIDs();
        yield* alerts.clear(turnAlert(id));
        if (!hasProviderFailure()) {
          providerTimer?.interruptUnsafe();
          providerTimer = undefined;
          yield* alerts.clear(provider);
        }
        if (wasQuota) {
          capTimer!.interruptUnsafe();
          for (const other of held) pending.delete(other);
          yield* alerts.clear(cap);
          yield* Effect.forEach(held, (other) => resume(other).pipe(Effect.forkScoped));
        }
      });

    yield* Stream.runForEach(
      host.events.subscribe([SessionEvent.Execution.Failed, SessionEvent.Execution.Succeeded]),
      (event) =>
        event.type === "session.execution.failed"
          ? onFailed(event)
          : onSucceeded(event.data.sessionID),
    ).pipe(Effect.forkScoped);

    for (const conversation of yield* directory.all()) {
      const session = yield* host.sessions
        .get(Session.ID.make(conversation.sessionID))
        .pipe(Effect.option);
      if (Option.isSome(session) && session.value.outcome === "failed") {
        yield* resume(conversation.sessionID);
      }
    }
  });
