import { Effect } from "effect";
import { observe } from "../diagnostics.ts";

/** Correlate transport requests with native submission without echoing private inputs. */
export const messageRequest = <A extends object>(
  operation: string,
  body: (requestId: string) => Effect.Effect<A, Error>,
) =>
  Effect.suspend(() => {
    const requestId = crypto.randomUUID();
    return observe(operation, body(requestId), () => ({}), requestId).pipe(
      Effect.map((value) => ({ ...value, requestId })),
      Effect.mapError(() => `Messaging operation failed (request ${requestId})`),
    );
  });
