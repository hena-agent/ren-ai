import { expect, test } from "vitest";
import { locationConfig } from "./location-config.ts";
import { Config } from "@opencode/schema";
import { Schema } from "effect";

test("persona location uses the pinned V2 config shape without changing global configuration", () => {
  expect(
    JSON.parse(
      locationConfig({
        callback: "https://api-msg.hena.dev/rpc",
        disabledPlugins: [
          "translation",
          "/root/.config/opencode/plugins/discord",
          "opencode.config.instruction",
          "opencode.config.agent",
          "personas",
        ],
      }),
    ),
  ).toEqual({
    plugins: [
      "-translation",
      "-/root/.config/opencode/plugins/discord",
      "-personas",
      "-/srv/ren-ai/plugin",
      ...["tools", "context", "memory", "title"].map((name) => ({
        package: `/srv/ren-ai/plugins/${name}/src`,
        options: {
          directory: "/srv/ren-ai",
          url: "https://api-msg.hena.dev/rpc",
          tokenFile: "/srv/ren-ai/application.token",
        },
      })),
      {
        package: "/srv/ren-ai/plugins/session-folder/src",
        options: { directory: "/srv/ren-ai" },
      },
    ],
    compaction: { buffer: 400000, keep: { tokens: 12000 } },
  });
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Config.Info))(
      locationConfig({ callback: "https://app.test/rpc", disabledPlugins: [] }),
    ).plugins,
  ).toHaveLength(7);
});
