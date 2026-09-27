import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { experimental_evaluate } from "ai";
import { createLab } from "./lab.ts";
import { createJudge } from "./judge.ts";
import { createStore } from "./store.ts";
import { liveModel } from "./model.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("../public/base.css", import.meta.url), "utf8");
const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const port = Number(process.env.PORT ?? 3000);
const lab = createLab(
  page,
  stylesheet,
  liveModel({
    key: process.env.GEMINI_API_KEY ?? "",
    endpoint: process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta",
    name: model,
    fetcher: fetch,
  }),
  createJudge(async (state, questions) => {
    if (!process.env.AI_GATEWAY_API_KEY) throw new Error("Set AI_GATEWAY_API_KEY to use Jev");
    const result = await experimental_evaluate({ model: "typesafe-ai/jev", state, questions });
    return result.answers;
  }),
  createStore(fileURLToPath(new URL("../data", import.meta.url))),
  (event) => {
    const line = `[persona-lab] ${event.persona}/${event.session.slice(0, 8)} ${event.trigger} ${event.action} ${event.durationMs}ms${event.error ? ` error=${event.error}` : ""}\n`;
    (event.error ? process.stderr : process.stdout).write(line);
  },
  () => Date.now(),
);

// oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access -- thin Bun entry shim; request and decision logic live in tested modules
Bun.serve({ hostname: "127.0.0.1", port, fetch: lab.handle });
process.stdout.write(
  `[persona-lab] http://127.0.0.1:${port} · Jev ${process.env.AI_GATEWAY_API_KEY ? "ready" : "key missing"} · Gemini ${process.env.GEMINI_API_KEY ? "ready" : "key missing"} · model=${model}\n`,
);
const check = () => {
  void lab
    .runDue()
    .catch((error) =>
      process.stderr.write(
        `[persona-lab] check failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
      ),
    );
};
check();
setInterval(check, 5_000);
