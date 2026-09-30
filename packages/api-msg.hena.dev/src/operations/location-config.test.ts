import { expect, test } from "vitest";
import { locationConfig } from "./location-config.ts";
import { Config } from "@opencode/schema";
import { Schema } from "effect";

test("persona location uses the pinned V2 config shape without changing global configuration", () => {
  expect(
    JSON.parse(
      locationConfig({
        callback: "https://api-msg.hena.dev/rpc",
        disabledPlugins: ["translation", "/root/.config/opencode/plugins/discord"],
      }),
    ),
  ).toEqual({
    plugins: [
      "-translation",
      "-/root/.config/opencode/plugins/discord",
      {
        package: "/srv/ren-ai/plugin",
        options: {
          directory: "/srv/ren-ai",
          url: "https://api-msg.hena.dev/rpc",
          tokenFile: "/srv/ren-ai/application.token",
        },
      },
    ],
    compaction: { buffer: 400000, keep: { tokens: 12000 } },
  });
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(Config.Info))(
      locationConfig({ callback: "https://app.test/rpc", disabledPlugins: [] }),
    ).plugins,
  ).toHaveLength(1);
});
