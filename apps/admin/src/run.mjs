import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPersonaStore } from "@ren-ai/personas";
import { createAdmin } from "./admin.ts";

const directory =
  process.env.PERSONA_DIRECTORY ?? fileURLToPath(new URL("../data/personas", import.meta.url));
const store = await createPersonaStore(directory);
const handle = createAdmin(
  store,
  process.env.ADMIN_PASSWORD ?? "",
  readFileSync(new URL("../public/style.css", import.meta.url), "utf8"),
);
const port = Number(process.env.PORT ?? 3729);
// oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- thin Bun entry shim; handler and persistence are tested through their public interfaces
Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
process.stdout.write(`[admin] http://127.0.0.1:${port} · personas: ${directory}\n`);
