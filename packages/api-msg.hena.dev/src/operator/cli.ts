import { Effect } from "effect";
import { operatorClient } from "./socket.ts";

/** The future CLI entry file only passes argv and the state socket path here. */
export const runOperatorCli = (args: readonly string[], socketPath: string) =>
  Effect.gen(function* () {
    const [command, handle] = args;
    if (
      !handle ||
      (command !== "remove" && command !== "block" && command !== "rebuild") ||
      args.length !== 2
    ) {
      return yield* Effect.fail(new Error("Usage: operator remove|block|rebuild HANDLE"));
    }
    const client = yield* operatorClient(socketPath);
    if (command === "block") {
      yield* client.operator.block({ payload: { handle } });
      return `Blocked ${handle}`;
    }
    if (command === "rebuild") {
      const answer = yield* client.operator.rebuild({ payload: { handle } });
      return answer.result === "rebuilt" ? `Rebuilt ${handle}` : `No User for ${handle}`;
    }
    const answer = yield* client.operator
      .remove({ payload: { handle } })
      .pipe(Effect.retry({ times: 2 }));
    return answer.result === "removed" ? `Removed ${handle}` : `No User for ${handle}`;
  });
