import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, test } from "vitest";
import { failure } from "../../test/messages-ui.test-helper.ts";
import { makeMessagesUi } from "./messages-ui.ts";

const alice = "alice@example.com";
const chat = '{"id":42,"identifier":"alice@example.com","service":"iMessage","is_group":false}';

/** The adapter's osascript and imsg calls, answered by real `sh` child processes. */
const gesturesOnRealProcesses = (script: (executable: string, action: string) => string) =>
  Effect.gen(function* () {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      ChildProcess.isStandardCommand(command)
        ? real.spawn(
            ChildProcess.make("sh", [
              "-c",
              script(command.command, command.args[command.command === "imsg" ? 0 : 1]!),
            ]),
          )
        : Effect.die("Unexpected pipeline"),
    );
    return yield* makeMessagesUi({ raise: () => Effect.void, clear: () => Effect.void }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  }).pipe(Effect.provide(NodeServices.layer));

test("a real child process that exits non-zero fails the gesture with its stderr", async () => {
  const ui = await Effect.runPromise(
    gesturesOnRealProcesses((_, action) =>
      action === "ensure" ? "echo 'composer is not focused' >&2; exit 3" : "exit 0",
    ),
  );
  expect(await failure(ui.read(alice))).toBe(
    "Messages UI ensure: exit code 3: composer is not focused",
  );
});

test("a real child process that fills stderr before it writes cannot stall the gesture", async () => {
  const ui = await Effect.runPromise(
    gesturesOnRealProcesses((executable) =>
      executable === "imsg" ? `echo '${chat}'` : "head -c 4000000 /dev/zero >&2",
    ),
  );
  await expect(Effect.runPromise(ui.read(alice))).resolves.toBeUndefined();
});
