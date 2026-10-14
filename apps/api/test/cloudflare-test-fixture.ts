import { Schema } from "effect";
import { Miniflare } from "miniflare";
import { afterEach } from "vitest";

const runtimes: Miniflare[] = [];

export const trackRuntime = (runtime: Miniflare) => {
  runtimes.push(runtime);
  return runtime;
};

export const stopRuntimes = async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
};

export const contactEntries = async (readText: () => Promise<string>) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        entries: Schema.Array(Schema.Struct({ id: Schema.String, handle: Schema.String })),
      }),
    ),
  )(await readText());

afterEach(stopRuntimes);
