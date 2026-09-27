import { Effect } from "effect";
import { operatorClient } from "./socket.ts";

/** The future CLI entry file only passes argv and the state socket path here. */
export const runOperatorCli = (args: readonly string[], socketPath: string) =>
  Effect.gen(function* () {
    const [command, handle] = args;
    if (
      !handle ||
      !["remove", "block", "rebuild", "remove-waitlist"].includes(command!) ||
      args.length !== 2
    ) {
      return yield* Effect.fail(
        new Error("Usage: operator remove|block|rebuild HANDLE | remove-waitlist EMAIL"),
      );
    }
    const client = yield* operatorClient(socketPath);
    if (command === "remove-waitlist") {
      const answer = yield* client.operator.removeWaitlist({ payload: { email: handle } });
      return answer.result === "removed"
        ? `Removed Waitlist ${handle}`
        : `No Waitlist email for ${handle}`;
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
