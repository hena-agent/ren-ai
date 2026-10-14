import { Effect, Option, Stream } from "effect";

type WaitInput = { sessionID: string; seconds: number };
export type WaitClient = { wait: (input: WaitInput) => Stream.Stream<string, string | Error> };

class ApplicationWaitError extends Error {}
const failure = (error: string | Error) =>
  new Error(error instanceof ApplicationWaitError ? error.message : String(error));

export const waitForResult = (client: WaitClient, sessionID: string, seconds: number) => {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  const retry = (): Effect.Effect<string, Error> => {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return Effect.fail(new Error("Wait stream ended without a result"));
    return Effect.sleep(Math.min(250, remaining)).pipe(
      Effect.flatMap(() => {
        const next = Math.max(0, (deadline - Date.now()) / 1000);
        return next > 0 ? read(next) : Effect.fail(new Error("Wait stream ended without a result"));
      }),
    );
  };
  const read: (remaining: number) => Effect.Effect<string, Error> = (remaining) =>
    client.wait({ sessionID, seconds: remaining }).pipe(
      Stream.filter((output) => output !== ""),
      Stream.runLast,
      Effect.flatMap((result) => (Option.isSome(result) ? Effect.succeed(result.value) : retry())),
      Effect.mapError((error) =>
        error instanceof Error ? error : new ApplicationWaitError(error),
      ),
      Effect.catch((error) =>
        error instanceof ApplicationWaitError ? Effect.fail(error) : retry(),
      ),
      Effect.mapError(failure),
    );
  return read(Math.max(0, seconds));
};
