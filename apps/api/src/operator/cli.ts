import { Effect } from "effect";
import { operatorClient, operatorConnection, type OperatorConnection } from "./clientHttp.ts";

const usage =
  "Usage: operator remove|block|rebuild|test-handle|untest-handle HANDLE | release-send HANDLE CALL_ID failed|delivered | photos on|off";

const photosCommand = (args: readonly string[], connection?: OperatorConnection) =>
  Effect.gen(function* () {
    const setting = args[1];
    if (args.length !== 2 || (setting !== "on" && setting !== "off"))
      return yield* Effect.fail(new Error(usage));
    const client = yield* operatorClient(connection ?? (yield* operatorConnection));
    yield* client.operator.photoTaking({ payload: { enabled: setting === "on" } });
    return `Photo-taking ${setting}`;
  });

export const runOperatorCli = (args: readonly string[], connection?: OperatorConnection) =>
  Effect.gen(function* () {
    const [command, handle, callID, outcome] = args;
    if (command === "photos") return yield* photosCommand(args, connection);
    if (
      command === "release-send" &&
      handle &&
      callID &&
      args.length === 4 &&
      (outcome === "failed" || outcome === "delivered")
    ) {
      const client = yield* operatorClient(connection ?? (yield* operatorConnection));
      const { result } = yield* client.operator.releaseSend({
        payload: { handle, callID, outcome },
      });
      return `Send recovery: ${result}`;
    }
    if (
      !handle ||
      !["remove", "block", "rebuild", "test-handle", "untest-handle"].includes(command!) ||
      args.length !== 2
    ) {
      return yield* Effect.fail(new Error(usage));
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
