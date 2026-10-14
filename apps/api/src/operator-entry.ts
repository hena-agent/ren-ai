import { join } from "node:path";
import { Effect } from "effect";
import { runOperatorCli } from "./operator/cli.ts";

const state = process.env["STATE_DIRECTORY"];
if (!state) throw new Error("STATE_DIRECTORY is required");
process.stdout.write(
  (await Effect.runPromise(
    runOperatorCli(process.argv.slice(2), join(state, "operator", "operator.sock")),
  )) + "\n",
);
