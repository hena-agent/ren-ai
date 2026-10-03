import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { decodePersona, PersonaError, serializePersona } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord } from "@ren-ai/personas";
import {
  authorPersona,
  descriptionOf,
  emptyPersona,
  needsIntroduction,
  readIntent,
  readPortraitInstructions,
  requireMatchingProfile,
} from "./authoring.ts";
import { draftFor, draftTokens, previewOf } from "./draft.ts";
import type { Draft } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { renderPage } from "./page.tsx";
import type { PageContent } from "./page.tsx";
import copy from "./copy.json";
import { characterDraft, profileDraft } from "./generation-workflows.ts";
import {
  loggedRequest,
  operation,
  protect,
  reportFailure,
  requestFields,
  requestId,
} from "./logging.ts";
import type { Log } from "./logging.ts";

const html = (page: string, status = 200) =>
  new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });

export function createAdmin(
  store: Awaited<ReturnType<typeof createPersonaStore>>,
  password: string,
  stylesheet: string,
  { generator, script, log }: { generator?: ProfileGenerator; script?: string; log?: Log } = {},
) {
  if (!password.trim()) throw new Error("ADMIN_PASSWORD is required");
  const expected = createHash("sha256")
    .update(`Basic ${Buffer.from(`admin:${password}`).toString("base64")}`)
    .digest();
  const tokens = draftTokens(password);
  const busy = new Set<string>();
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow request, generation and storage failures before responding
  const failure = (error: unknown, record?: PersonaRecord, draft?: Draft) => {
    reportFailure(error, { stage: "request" }, error instanceof PersonaError ? "warn" : "error");
    const content: PageContent =
      record && draft
        ? {
            record,
            draft: tokens.encode(draft),
            editing: Boolean(draft.base),
            seed: draft.seed,
            portraitInstructions: draft.portraitInstructions,
          }
        : { personas: [] };
    return html(
      renderPage({
        ...content,
        error: `${error instanceof PersonaError ? error.message : copy.failure} (요청 ID: ${requestId()})`,
      }),
      error instanceof PersonaError
        ? { invalid: 400, not_found: 404, conflict: 409 }[error.kind]
        : 503,
    );
  };

  const execute = async (
    persona: ReturnType<typeof authorPersona>,
    draft: Draft,
    intent: ReturnType<typeof readIntent>,
  ) => {
    if (busy.has(draft.id)) throw new PersonaError("conflict", copy.busy);
    busy.add(draft.id);
    try {
      if (draft.base && serializePersona(await store.get(draft.id)) !== draft.base)
        throw new PersonaError("conflict", copy.stale);
      if (intent === "save") {
        requireMatchingProfile(persona, previewOf(draft, emptyPersona));
        const valid = decodePersona(persona);
        await operation("persona.save", {}, () =>
          draft.base ? store.update(valid) : store.create(valid),
        );
        return new Response(null, {
          status: 303,
          headers: { Location: `/personas/${valid.id}?saved=1` },
        });
      }
      if (intent === "portrait") {
        if (!persona.bio) throw new PersonaError("invalid", copy.regenerateRequired);
        requireMatchingProfile(persona, previewOf(draft, emptyPersona));
      }
      if (!generator) {
        reportFailure(new Error("Profile generator is not configured"), {
          stage: "generation.configuration",
        });
        return html(
          renderPage({
            record: persona,
            editing: Boolean(draft.base),
            draft: tokens.encode(draft),
            seed: draft.seed,
            portraitInstructions: draft.portraitInstructions,
            error: `${copy.generationUnavailable} (요청 ID: ${requestId()})`,
          }),
          503,
        );
      }
      const generated =
        intent === "character"
          ? await characterDraft(draft.seed!, persona, generator)
          : await profileDraft(
              persona,
              intent === "generate" && needsIntroduction(persona, previewOf(draft, emptyPersona)),
              generator,
              store,
              draft.portraitInstructions,
            );
      const next = {
        ...draft,
        preview: serializePersona(generated),
      };
      return html(
        renderPage({
          record: generated,
          editing: Boolean(draft.base),
          draft: tokens.encode(next),
          seed: next.seed,
          portraitInstructions: next.portraitInstructions,
        }),
      );
    } finally {
      busy.delete(draft.id);
    }
  };

  const submit = async (request: Request, url: URL, id: string | undefined) => {
    let record: ReturnType<typeof authorPersona> | undefined;
    let draft: Draft | undefined;
    try {
      if (request.headers.get("origin") !== url.origin)
        throw new PersonaError("invalid", copy.originError);
      if (url.pathname !== "/personas" && !id)
        return html(renderPage({ personas: [], error: copy.notFound }), 404);
      const form = await request.formData().catch(() => {
        throw new PersonaError("invalid", copy.formError);
      });
      draft = tokens.decode(form.get("draft"));
      protect(
        ...["draft", "name", "description", "seed", "portraitInstructions"].map((key) => {
          const value = form.get(key);
          return typeof value === "string" ? value : "";
        }),
      );
      requestFields({ personaId: draft.id });
      if ((id && (id !== draft.id || !draft.base)) || (!id && draft.base))
        throw new PersonaError("invalid", copy.identityError);
      const intent = readIntent(form);
      requestFields({ intent });
      const previous = previewOf(draft, emptyPersona);
      if (intent === "character") {
        record = { ...previous, description: descriptionOf(previous) };
        const seed = form.get("seed");
        if (typeof seed !== "string" || !seed.trim())
          throw new PersonaError("invalid", copy.seedRequired);
        draft = { ...draft, seed: seed.trim() };
      } else {
        record = authorPersona(form, previous);
        if (!record.name || !record.description)
          throw new PersonaError("invalid", copy.characterRequired);
      }
      if (intent === "portrait" || intent === "generate")
        draft = { ...draft, portraitInstructions: readPortraitInstructions(form) };
      return await execute(record, draft, intent);
    } catch (error) {
      return failure(error, record, draft);
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/personas")
        return Response.json(await operation("persona.publicList", {}, store.publicList), {
          headers: { "Cache-Control": "no-store" },
        });
      const authorization = request.headers.get("authorization");
      if (
        !authorization ||
        !timingSafeEqual(createHash("sha256").update(authorization).digest(), expected)
      )
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Persona Admin", charset="UTF-8"',
            "Cache-Control": "no-store",
          },
        });
      if (request.method !== "GET" && request.method !== "POST")
        return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
      if (request.method === "GET" && url.pathname === "/style.css")
        return new Response(stylesheet, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (request.method === "GET" && url.pathname === "/pending.js")
        return new Response(script, {
          headers: { "Content-Type": "text/javascript; charset=utf-8" },
        });
      if (request.method === "GET" && url.pathname.startsWith("/images/"))
        return await operation("image.read", {}, () =>
          store.image(url.pathname.slice("/images/".length)),
        );
      const match = /^\/personas\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (request.method === "POST") return submit(request, url, match?.[1]);
      let record: PersonaRecord | undefined;
      if (match)
        record = await operation("persona.get", { personaId: match[1]! }, () =>
          store.get(match[1]!),
        );
      else if (url.pathname === "/new") record = { ...emptyPersona, id: randomUUID() };
      else if (url.pathname !== "/")
        return html(renderPage({ personas: [], error: copy.notFound }), 404);
      const content: PageContent = record
        ? {
            record,
            editing: Boolean(match),
            draft: tokens.encode(draftFor(record, Boolean(match))),
          }
        : { personas: await operation("persona.list", {}, store.list) };
      return html(
        renderPage({
          ...content,
          saved: url.searchParams.get("saved") === "1",
        }),
      );
    } catch (error) {
      return failure(error);
    }
  };
  return (request: Request) => loggedRequest(request, () => handle(request), log);
}
