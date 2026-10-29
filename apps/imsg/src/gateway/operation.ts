import { Effect } from "effect";
import { observe } from "../diagnostics.ts";

/** Correlate transport requests with native submission without echoing private inputs. */
export const messageRequest = <A extends object>(
  operation: string,
  body: (requestId: string) => Effect.Effect<A, Error>,
  details = false,
) =>
  Effect.suspend(() => {
    const requestId = crypto.randomUUID();
    return observe(operation, body(requestId), () => ({}), requestId).pipe(
      Effect.map((value) => ({ ...value, requestId })),
      Effect.mapError((failure) => {
        const cause = failure.cause instanceof Error ? failure.cause : failure;
        const stage = "stage" in cause ? cause.stage : undefined;
        const code = "code" in cause ? cause.code : undefined;
        const detail =
          details &&
          typeof stage === "string" &&
          /^[a-z_]{1,80}$/.test(stage) &&
          typeof code === "string" &&
          /^[a-zA-Z0-9_-]{1,80}$/.test(code)
            ? ` [stage=${stage};code=${code}]`
            : "";
        return `Messaging operation failed${detail} (request ${requestId})`;
      }),
    );
  });
