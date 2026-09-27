import { ABSORB_MS, begin, admit, decide, pendingFor } from "./loop.ts";
import type { Character, Outcome } from "./loop.ts";
import { createStore, restore } from "./store.ts";
import type { Saved, SessionInfo } from "./store.ts";
import { personas } from "./personas.ts";
import type { Judge } from "./judge.ts";
import type { Event, Model } from "@repo/persona-engine";

export type TurnLog = {
  session: string;
  persona: string;
  trigger: "input" | "tick";
  action: string;
  durationMs: number;
  error?: string;
};
export type Lab = { handle: (request: Request) => Promise<Response>; runDue: () => Promise<void> };

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: browser input JSON
const inputFrom = (value: unknown): Event => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !("kind" in value) ||
    (value.kind !== "user" && value.kind !== "life")
  )
    throw new Error("Invalid input");
  return { id: value.id, kind: value.kind, text: value.text };
};

const staticResponse = (
  method: string,
  pathname: string,
  page: string,
  stylesheet: string,
): Response | null => {
  if (method === "GET" && pathname === "/")
    return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (method === "GET" && pathname === "/base.css")
    return new Response(stylesheet, { headers: { "Content-Type": "text/css; charset=utf-8" } });
  return null;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: normalize any thrown value from request handlers
const errorOf = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export const createLab = (
  page: string,
  stylesheet: string,
  model: Model,
  judge: Judge,
  store: ReturnType<typeof createStore>,
  log: (event: TurnLog) => void,
  clock: () => number,
): Lab => {
  const characters = new Map<string, Saved>();
  const queues = new Map<string, Promise<void>>();
  const serialized = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    queues.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };
  const remember = (persona: string, character: Character): Character => {
    characters.set(character.session.id, { persona, character });
    return character;
  };
  const load = async (id: string): Promise<Saved | undefined> => {
    const cached = characters.get(id);
    if (cached) return cached;
    const saved = await store.load(id);
    if (!saved) return undefined;
    remember(saved.persona, saved.character);
    return saved;
  };
  const commit = async (persona: string, character: Character): Promise<Character> => {
    await store.save(persona, character);
    return remember(persona, character);
  };
  const evaluate = async (
    id: string,
    persona: string,
    character: Character,
    trigger: "input" | "tick",
    at: number,
  ): Promise<Outcome> => {
    const started = clock();
    const result = await decide(character, trigger, at, crypto.randomUUID(), judge, model);
    await commit(persona, result.character);
    log({
      session: id,
      persona,
      trigger,
      action: result.decision.action,
      durationMs: Math.round(clock() - started),
      ...(result.decision.error ? { error: result.decision.error } : {}),
    });
    return result;
  };
  const evaluateDue = (persona: string, character: Character, at: number): Promise<Outcome> =>
    evaluate(
      character.session.id,
      persona,
      character,
      pendingFor(character.session).length ? "input" : "tick",
      at,
    );
  const withSession = async (
    id: string | null,
    operation: (character: Character, persona: string) => Promise<Response>,
  ): Promise<Response> => {
    if (!id) return Response.json({ error: "Missing session" }, { status: 404 });
    try {
      return await serialized(id, async () => {
        const saved = await load(id);
        if (!saved) return Response.json({ error: "Unknown session" }, { status: 404 });
        return operation(saved.character, saved.persona);
      });
    } catch (error) {
      return Response.json({ error: errorOf(error, "Invalid request") }, { status: 400 });
    }
  };
  const newSession = async (persona: string | null): Promise<Response> => {
    if (!persona) return Response.json({ error: "Missing Persona" }, { status: 404 });
    const definition = personas[persona];
    if (!definition) return Response.json({ error: "Unknown Persona" }, { status: 404 });
    try {
      const id = crypto.randomUUID();
      return Response.json(await commit(persona, begin(definition, id, clock())));
    } catch (error) {
      return Response.json({ error: errorOf(error, "Invalid request") }, { status: 400 });
    }
  };
  const listSessions = async (persona: string | null): Promise<Response> => {
    try {
      const all: SessionInfo[] = await store.list();
      return Response.json(persona ? all.filter((info) => info.persona === persona) : all);
    } catch (error) {
      return Response.json({ error: errorOf(error, "Invalid request") }, { status: 400 });
    }
  };
  const handleInput = async (
    request: Request,
    character: Character,
    persona: string,
  ): Promise<Response> => {
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: browser request JSON
    const input: unknown = await request.json();
    const at = clock() + character.offset;
    const admitted = admit(character, inputFrom(input), at);
    const queued: Character = {
      ...admitted,
      nextCheckAt: at + ABSORB_MS,
    };
    return Response.json(await commit(persona, queued));
  };
  const handleTick = async (url: URL, character: Character, persona: string): Promise<Response> => {
    const minutes = Number(url.searchParams.get("minutes") ?? "5");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440)
      throw new Error("Invalid time step");
    const shifted = { ...character, offset: character.offset + minutes * 60_000 };
    const at = clock() + shifted.offset;
    if (at < shifted.nextCheckAt) return Response.json(await commit(persona, shifted));
    return Response.json((await evaluateDue(persona, shifted, at)).character);
  };
  const handleReset = async (character: Character, persona: string): Promise<Response> => {
    const definition = personas[persona]!;
    return Response.json(await commit(persona, begin(definition, character.session.id, clock())));
  };
  const handleImport = async (request: Request, id: string): Promise<Response> => {
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: imported character JSON
    const data: unknown = await request.json();
    if (typeof data !== "object" || data === null || !("persona" in data))
      throw new Error("Invalid recording");
    const persona = data.persona;
    if (typeof persona !== "string") throw new Error("Invalid recording");
    return Response.json(await commit(persona, restore(persona, id, data)));
  };
  const routeSession = (
    request: Request,
    url: URL,
    session: string | null,
  ): Promise<Response> | null => {
    if (request.method === "GET" && url.pathname === "/session")
      return withSession(session, async (character) => Response.json(character));
    if (request.method === "POST" && url.pathname === "/input")
      return withSession(session, (character, persona) => handleInput(request, character, persona));
    if (request.method === "POST" && url.pathname === "/tick")
      return withSession(session, (character, persona) => handleTick(url, character, persona));
    if (request.method === "POST" && url.pathname === "/reset")
      return withSession(session, (character, persona) => handleReset(character, persona));
    if (request.method === "GET" && url.pathname === "/export")
      return withSession(session, async (character, persona) =>
        Response.json({
          persona,
          entries: character.entries,
          decisions: character.decisions,
          nextCheckAt: character.nextCheckAt,
          offset: character.offset,
          lastSentAt: character.lastSentAt,
        }),
      );
    if (request.method === "POST" && url.pathname === "/import")
      return withSession(session, () => handleImport(request, crypto.randomUUID()));
    return null;
  };
  return {
    handle: async (request) => {
      const url = new URL(request.url);
      const asset = staticResponse(request.method, url.pathname, page, stylesheet);
      if (asset) return asset;
      if (request.method === "GET" && url.pathname === "/sessions")
        return listSessions(url.searchParams.get("persona"));
      if (request.method === "POST" && url.pathname === "/new")
        return newSession(url.searchParams.get("persona"));
      return (
        routeSession(request, url, url.searchParams.get("session")) ??
        new Response("Not found", { status: 404 })
      );
    },
    runDue: async () => {
      for (const info of await store.list()) {
        await serialized(info.id, async () => {
          const saved = await load(info.id);
          if (!saved) return;
          const at = clock() + saved.character.offset;
          if (at >= saved.character.nextCheckAt)
            await evaluateDue(saved.persona, saved.character, at);
        });
      }
    },
  };
};
