import { readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { locationConfig } from "../src/operations/location-config.ts";

const [disabledFile, destination] = process.argv.slice(2);
if (!disabledFile || !destination)
  throw new Error(
    "Usage: bun ops/location-config.ts REVIEWED-PLUGIN-TARGETS.json NEW-opencode.json (native agent/instruction loaders stay enabled)",
  );
const disabledPlugins = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
)(await readFile(disabledFile, "utf8"));
await writeFile(
  destination,
  locationConfig({
    callback: process.env["REN_AI_CALLBACK_URL"] ?? "https://api-msg.hena.dev/rpc",
    disabledPlugins,
  }),
  { flag: "wx", mode: 0o600 },
);
