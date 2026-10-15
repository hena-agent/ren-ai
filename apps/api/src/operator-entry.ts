import { Effect } from "effect";
import { runOperatorCli } from "./operator/cli.ts";

process.stdout.write((await Effect.runPromise(runOperatorCli(process.argv.slice(2)))) + "\n");
