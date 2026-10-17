import { Effect, Stream } from "effect";

export const observationFailure = (
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: project untrusted RPC/event failures into payload-free diagnostics
  cause: unknown,
  stage: string,
  requestId: string,
  started: number,
) => {
  const root = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  const code =
    root instanceof Error &&
    "code" in root &&
    typeof root.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(root.code)
      ? root.code
      : "OBSERVATION_UNAVAILABLE";
  process.stderr.write(
    `${JSON.stringify({
      requestId,
      operation: "opencode.observation",
      stage,
      outcome: "failed",
      level: "error",
      durationMs: performance.now() - started,
      code,
      causeName:
        root instanceof Error && ["Error", "TypeError", "TimeoutError"].includes(root.name)
          ? root.name
          : "RpcError",
    })}\n`,
  );
};

/** A failed hint is recovered by Cloudflare's persisted probe and maintenance scan. */
export const observeTurns = <E, F>(
  events: Stream.Stream<{ type: string; data?: { sessionID: string } }, F>,
  notify: (sessionID: string) => Effect.Effect<void, E>,
) =>
  Effect.forever(
    events.pipe(
      Stream.runForEach((event) => {
        if (
          !event.data ||
          !["session.execution.failed", "session.execution.succeeded"].includes(event.type)
        )
          return Effect.void;
        const requestId = crypto.randomUUID();
        const started = performance.now();
        return notify(event.data.sessionID).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch((cause) =>
            Effect.sync(() => observationFailure(cause, "turn.delivery", requestId, started)),
          ),
        );
      }),
      Effect.catch((cause) =>
        Effect.sync(() =>
          observationFailure(cause, "turn.subscribe", crypto.randomUUID(), performance.now()),
        ),
      ),
      Effect.andThen(Effect.sleep("1 second")),
    ),
  ).pipe(Effect.forkScoped);
