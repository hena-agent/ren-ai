import { join } from "node:path";
import { Effect } from "effect";
import { runOperatorCli } from "./operator/cli.ts";

const state = process.env["XDG_STATE_HOME"];
if (!state) throw new Error("XDG_STATE_HOME is required");
process.stdout.write(
  (await Effect.runPromise(
    runOperatorCli(process.argv.slice(2), join(state, "operator", "operator.sock")),
  )) + "\n",
);
