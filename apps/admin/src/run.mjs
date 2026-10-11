import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { build, serve } from "bun";
import { createPersonaStore } from "@ren-ai/personas";
import { createAdmin } from "./admin.ts";
import { createProfileGenerator } from "./generation.ts";

const directory =
  process.env.PERSONA_DIRECTORY ?? fileURLToPath(new URL("../data/personas", import.meta.url));
const store = await createPersonaStore(directory);
const labEnvironment = new URL("../../persona-lab/.env", import.meta.url);
const key =
  process.env.GEMINI_API_KEY ??
  (existsSync(labEnvironment)
    ? (parseEnv(readFileSync(labEnvironment, "utf8"))["GEMINI_API_KEY"] ?? "")
    : "");
const bundle = await build({
  entrypoints: [fileURLToPath(new URL("./pending-entry.mjs", import.meta.url))],
  target: "browser",
});
if (!bundle.success) throw new AggregateError(bundle.logs, "Admin browser build failed");
const script = await bundle.outputs[0].text();
const handle = createAdmin(
  store,
  process.env.ADMIN_PASSWORD ?? "",
  ["style.css", "editor.css"]
    .map((file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"))
    .join("\n"),
  {
    script,
    generator: createProfileGenerator({
      key,
      endpoint: process.env.GEMINI_API_URL,
      textModel: process.env.ADMIN_TEXT_MODEL,
      imageModel: process.env.ADMIN_IMAGE_MODEL,
    }),
  },
);
const port = Number(process.env.PORT ?? 3729);
// A gallery spans several provider calls, each independently bounded to 120 seconds.
// Bun's default idle timeout would reset the connection before the preview is ready.
const server = serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: handle });
process.stdout.write(
  `${JSON.stringify({ time: new Date().toISOString(), service: "admin", level: "info", event: "server.started", url: `http://127.0.0.1:${server.port}`, directory, generationConfigured: Boolean(key.trim()) })}\n`,
);
