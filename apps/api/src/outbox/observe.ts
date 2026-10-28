import { Effect, Exit, Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";

/** The transport failure already has a correlated diagnostic. */
export class ObservedSendFailure extends Error {}

export const observeSend = <A, R>(
  stage: string,
  operationId: string,
  effect: Effect.Effect<A, Error, R>,
) =>
  Effect.gen(function* () {
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
    const requestId =
      Option.getOrUndefined(request)?.headers["x-operation-id"] ?? crypto.randomUUID();
    const started = performance.now();
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const fields = {
            requestId,
            operationId,
            operation: "send",
            stage,
            durationMs: performance.now() - started,
          };
          if (Exit.isSuccess(exit)) contactLog({ ...fields, outcome: "completed", level: "info" });
          else {
            const failure = exit.cause.reasons.find((reason) => reason["_tag"] === "Fail")?.error;
            contactLog({ ...fields, ...contactCause(failure), outcome: "failed", level: "error" });
          }
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ObservedSendFailure(`Messaging operation unavailable; request ${requestId}`, {
            cause,
          }),
      ),
    );
  });
