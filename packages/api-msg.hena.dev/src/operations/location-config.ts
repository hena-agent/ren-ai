import { Config } from "@opencode/schema";
import { Schema } from "effect";

/** Isolate runtime plugins without disabling native agent/instruction files. */
export const locationConfig = (input: {
  readonly callback: string;
  readonly disabledPlugins: ReadonlyArray<string>;
}) =>
  Schema.encodeSync(Schema.fromJsonString(Config.Info))(
    Schema.decodeUnknownSync(Config.Info)({
      plugins: [
        ...new Set(
          [...input.disabledPlugins, "personas", "/srv/ren-ai/plugin"]
            .filter(
              (target) =>
                !["opencode.config.instruction", "opencode.config.agent"].includes(target),
            )
            .map((target) => `-${target}`),
        ),
        ...["tools", "context", "memory", "title"].map((name) => ({
          package: `/srv/ren-ai/plugins/${name}/src`,
          options: {
            directory: "/srv/ren-ai",
            url: input.callback,
            tokenFile: "/srv/ren-ai/application.token",
          },
        })),
        {
          package: "/srv/ren-ai/plugins/session-folder/src",
          options: { directory: "/srv/ren-ai" },
        },
      ],
      compaction: { buffer: 400_000, keep: { tokens: 12_000 } },
    }),
  );
