import { PersonaError } from "@ren-ai/personas";
import { readSeedManifest, seedError, seedSecrets } from "./seed-selection.ts";
import { seedingPage } from "./seeding-page.tsx";
import type { SeedingStore } from "./seeding-store.ts";
import type { seedingEngine } from "./seeding-engine.ts";
import { protect } from "./logging.ts";

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw seedError();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > 5_000_000) {
      await reader.cancel();
      throw seedError();
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function updateRun(
  request: Request,
  repository: SeedingStore,
  engine: ReturnType<typeof seedingEngine>,
  id: string,
) {
  const { run, seeds } = await repository.get(id);
  const form = await new Response(await readBody(request), { headers: request.headers })
    .formData()
    .catch(() => {
      throw seedError();
    });
  if (form.get("intent") === "confirm") {
    const budget = Number(form.get("budget"));
    if (!Number.isFinite(budget) || budget < 1 || budget > 1000) throw seedError();
    await engine.confirm(run.id, Math.round(budget * 1e6));
  } else if (form.get("intent") === "publish") {
    const ids = form.getAll("persona");
    if (!ids.every((value): value is string => typeof value === "string")) throw seedError();
    await engine.publish(run, seeds, ids);
  } else if (form.get("intent") === "retry") {
    const seed = seeds.find((entry) => entry.personaId === form.get("persona"));
    if (!run.confirmed || !seed) throw seedError();
    await engine.retry(seed);
  } else throw seedError();
  return new Response(null, { status: 303, headers: { Location: `/seeding/${id}` } });
}

export async function seedingRoutes(
  request: Request,
  repository: SeedingStore,
  engine: ReturnType<typeof seedingEngine>,
) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/seeding")) return undefined;
  if (request.method === "GET" && url.pathname === "/seeding/exclusions")
    return Response.json(await repository.exclusions(url.searchParams.get("cursor") ?? undefined), {
      headers: { "Cache-Control": "no-store" },
    });
  const match = /^\/seeding\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (url.pathname !== "/seeding" && !match)
    throw new PersonaError("not_found", "Seeding run not found");
  if (request.method === "GET") {
    if (!match) return seedingPage(await repository.list(), engine.models);
    const { run, seeds } = await repository.get(match[1]!);
    return seedingPage([], engine.models, { run, seeds: await engine.review(seeds) });
  }
  if (request.headers.get("origin") !== url.origin) throw seedError();
  if (match) return updateRun(request, repository, engine, match[1]!);
  const body = await readBody(request);
  const manifest = (() => {
    try {
      return readSeedManifest(JSON.parse(body));
    } catch {
      throw seedError();
    }
  })();
  protect(...manifest.seeds.flatMap(seedSecrets));
  const id = await repository.upload(manifest);
  return new Response(null, { status: 303, headers: { Location: `/seeding/${id}` } });
}
