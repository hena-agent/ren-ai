import { randomUUID } from "node:crypto";
import { Clock, Effect, Exit } from "effect";

const failureFields = (failure: Error | undefined) => {
  const error = failure?.cause instanceof Error ? failure.cause : failure;
  const code = error && "code" in error ? error.code : undefined;
  const stage = error && "stage" in error ? error.stage : undefined;
  return {
    causeName: error?.constructor.name ?? "InterruptedOrDefect",
    ...(typeof code === "number" || (typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(code))
      ? { code }
      : {}),
    ...(typeof stage === "string" && /^[a-z_]{1,80}$/.test(stage) ? { causeStage: stage } : {}),
    stack: error?.stack
      ?.split("\n")
      .filter((line) => /^\s+at .+:\d+:\d+\)?$/.test(line))
      .slice(0, 8)
      .join("\n")
      .slice(0, 2000),
  };
};

/** Emit payload-free timings through the gateway's Effect logger. */
export const observe = <A, E extends Error, R>(
  operation: string,
  body: Effect.Effect<A, E, R>,
  metrics: () => Record<string, number>,
  correlation?: string,
) =>
  Effect.gen(function* () {
    const requestId = correlation ?? randomUUID();
    const started = yield* Clock.currentTimeMillis;
    return yield* body.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const fields = {
            requestId,
            operation,
            stage: operation,
            durationMs: (yield* Clock.currentTimeMillis) - started,
            ...metrics(),
          };
          if (Exit.isSuccess(exit)) yield* Effect.logInfo({ ...fields, outcome: "completed" });
          else {
            const failure = exit.cause.reasons.find((reason) => reason["_tag"] === "Fail")?.error;
            yield* Effect.logError({
              ...fields,
              outcome: "failed",
              ...failureFields(failure),
            });
          }
        }),
      ),
    );
  });
