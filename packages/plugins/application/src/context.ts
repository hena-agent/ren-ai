import { Effect, Exit, Option, Schedule, Schema } from "effect";
import type { RpcClientError } from "effect/unstable/rpc";

const responseStatus = Schema.decodeUnknownOption(
  Schema.Struct({ response: Schema.Struct({ status: Schema.Number }) }),
);

/** Context acknowledgement/observation is repeatable; sends and reactions are not. */
export const resilientContext = <A>(
  request: Effect.Effect<A, string | RpcClientError.RpcClientError>,
  sessionID: string,
) =>
  Effect.gen(function* () {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    let failures = 0;
    const fields = { requestId, sessionID, operation: "turn.context", stage: "context.prepare" };
    return yield* request.pipe(
      Effect.timeout("10 seconds"),
      Effect.tapError((cause) =>
        Effect.sync(() => {
          failures++;
          if (failures !== 1) return;
          // RPC causes can contain authorization headers and the entire request payload.
          const code = typeof cause === "string" ? "ApplicationError" : cause["_tag"];
          const reason =
            typeof cause !== "string" && cause["_tag"] === "RpcClientError"
              ? cause.reason
              : undefined;
          const root =
            reason?.["_tag"] === "HttpError" && reason.cause instanceof Error
              ? reason.cause
              : cause;
          const underlyingCode =
            typeof root !== "string" &&
            "code" in root &&
            typeof root.code === "string" &&
            /^[A-Z][A-Z0-9_]{0,63}$/.test(root.code)
              ? root.code
              : undefined;
          const stack =
            typeof root === "string"
              ? ""
              : (root.stack
                  ?.split("\n")
                  .filter((line) =>
                    /^\s+at .*(?:\.(?:ts|js|mjs):\d+:\d+|node:.*:\d+:\d+)/.test(line),
                  )
                  .join("\n")
                  .slice(0, 4000) ?? "");
          process.stderr.write(
            `${JSON.stringify({
              ...fields,
              level: "error",
              outcome: "retrying",
              code,
              causeName: reason?.["_tag"] ?? code,
              underlyingCode,
              stack,
              ...(reason?.["_tag"] === "HttpError" && {
                causeCode: reason.kind,
                upstreamStatus: Option.getOrUndefined(
                  responseStatus(reason.cause).pipe(Option.map((value) => value.response.status)),
                ),
              }),
              durationMs: performance.now() - started,
            })}\n`,
          );
        }),
      ),
      Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])),
      Effect.orDie,
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (!failures) return;
          process.stdout.write(
            `${JSON.stringify({
              ...fields,
              level: "info",
              outcome: Exit.isSuccess(exit) ? "succeeded" : "interrupted",
              failures,
              durationMs: performance.now() - started,
            })}\n`,
          );
        }),
      ),
    );
  });
