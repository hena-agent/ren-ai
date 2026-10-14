import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, test } from "vitest";

const Package = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });

test("development launches Workers on the established port with Turbo TUI", async () => {
  const workspace = Schema.decodeUnknownSync(Package)(
    JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")),
  );
  const admin = Schema.decodeUnknownSync(Package)(
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
  );
  const turbo = Schema.decodeUnknownSync(Schema.Struct({ ui: Schema.String }))(
    JSON.parse(await readFile(new URL("../../../turbo.json", import.meta.url), "utf8")),
  );
  expect(turbo.ui).toBe("tui");
  expect(workspace.scripts["dev"]).toBe("turbo run dev");
  expect(admin.scripts["dev"]).toBe(
    "wrangler dev --port ${PORT:-3729} --var ADMIN_JURISDICTION:local",
  );
  expect(admin.scripts["deploy"]).toBe("wrangler deploy");
});
