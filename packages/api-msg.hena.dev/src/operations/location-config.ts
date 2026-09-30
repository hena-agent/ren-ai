import { Config } from "@opencode/schema";
import { Schema } from "effect";

/** Remove reviewed global plugin IDs/targets only within the persona location. */
export const locationConfig = (input: {
  readonly callback: string;
  readonly disabledPlugins: ReadonlyArray<string>;
}) =>
  Schema.encodeSync(Schema.fromJsonString(Config.Info))(
    Schema.decodeUnknownSync(Config.Info)({
      plugins: [
        ...input.disabledPlugins.map((target) => `-${target}`),
        {
          package: "/srv/ren-ai/plugin",
          options: {
            directory: "/srv/ren-ai",
            url: input.callback,
            tokenFile: "/srv/ren-ai/application.token",
          },
        },
      ],
      compaction: { buffer: 400_000, keep: { tokens: 12_000 } },
    }),
  );
