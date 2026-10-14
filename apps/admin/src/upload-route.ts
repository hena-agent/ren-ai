import { PersonaError } from "@ren-ai/personas";
import type { PersonaStore } from "@ren-ai/personas";
import { authorPersona, emptyPersona } from "./authoring.ts";
import { captureDocuments, documentsOf, draftTokens, previewOf } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { protectEditingForm } from "./image-actions.ts";
import { operation, requestFields } from "./logging.ts";
import { assertSnapshot } from "./snapshot.ts";
import { uploadImage } from "./upload-image.ts";
import { renderPage } from "./page.tsx";
import { html } from "./html-response.ts";
import copy from "./copy.json";

export async function uploadRoute(
  request: Request,
  url: URL,
  store: PersonaStore,
  tokens: ReturnType<typeof draftTokens>,
  drafts: Map<string, Draft>,
  busy: Set<string>,
  pending: (id: string) => string | undefined,
) {
  if (request.method !== "POST") throw new PersonaError("not_found", copy.notFound);
  if (request.headers.get("origin") !== url.origin)
    throw new PersonaError("invalid", copy.originError);
  const form = await request.formData().catch(() => {
    throw new PersonaError("invalid", copy.formError);
  });
  protectEditingForm(form);
  let draft = tokens.decode(form.get("draft"));
  requestFields({ personaId: draft.id, intent: "upload" });
  const latest = drafts.get(draft.id);
  if (latest && (latest.base !== draft.base || latest.preview !== draft.preview))
    throw new PersonaError("conflict", copy.stale);
  if (busy.has(draft.id) || pending(draft.id)) throw new PersonaError("conflict", copy.busy);
  busy.add(draft.id);
  try {
    draft = captureDocuments(form, draft);
    const persona = authorPersona(form, previewOf(draft, emptyPersona));
    await assertSnapshot(store, draft);
    const next = await operation("image.upload", {}, () =>
      uploadImage(form, url.searchParams, persona, draft, store),
    );
    await assertSnapshot(store, draft);
    drafts.set(draft.id, next);
    return html(
      renderPage({
        record: previewOf(next, emptyPersona),
        editing: Boolean(next.base),
        draft: tokens.encode(next),
        documents: documentsOf(next),
        tab: next.tab,
        changed: true,
      }),
    );
  } finally {
    busy.delete(draft.id);
  }
}
