import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const script = execFileSync(
  process.execPath,
  ["build", fileURLToPath(new URL("./pending-entry.mjs", import.meta.url)), "--target=browser"],
  { encoding: "utf8" },
);
const handle = createAdmin(
  store,
  process.env.ADMIN_PASSWORD ?? "",
  readFileSync(new URL("../public/style.css", import.meta.url), "utf8"),
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
// oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- thin Bun entry shim; handler and persistence are tested through their public interfaces
Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: handle });
process.stdout.write(
  `${JSON.stringify({ time: new Date().toISOString(), service: "admin", level: "info", event: "server.started", url: `http://127.0.0.1:${port}`, directory, generationConfigured: Boolean(key.trim()) })}\n`,
);
