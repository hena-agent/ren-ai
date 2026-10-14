import { Effect } from "effect";
import { operatorClient, operatorConnection, type OperatorConnection } from "./clientHttp.ts";

export const runOperatorCli = (args: readonly string[], connection?: OperatorConnection) =>
  Effect.gen(function* () {
    const [command, handle] = args;
    if (
      !handle ||
      !["remove", "block", "rebuild", "test-handle", "untest-handle"].includes(command!) ||
      args.length !== 2
    ) {
      return yield* Effect.fail(
        new Error("Usage: operator remove|block|rebuild|test-handle|untest-handle HANDLE"),
      );
    }
    const client = yield* operatorClient(connection ?? (yield* operatorConnection));
    if (command === "test-handle" || command === "untest-handle") {
      yield* client.operator.testHandle({
        payload: { handle, enabled: command === "test-handle" },
      });
      return command === "test-handle" ? `Test handle ${handle}` : `Unmarked ${handle}`;
    }
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
