import { PersonaError, serializePersona } from "@ren-ai/personas";
import { authorPersona, characterOf, emptyPersona, readPortraitInstructions } from "./authoring.ts";
import { previewOf, draftTokens, documentsOf, captureDocuments } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { protectEditingForm } from "./image-actions.ts";
import { protect, requestFields } from "./logging.ts";
import type { createImageQueue, ImageJob } from "./image-queue.ts";
import copy from "./copy.json";
import { html } from "./html-response.ts";
import { renderPage } from "./page.tsx";

export async function imageJobRoute(
  request: Request,
  url: URL,
  match: RegExpExecArray,
  queue: ReturnType<typeof createImageQueue>,
  tokens: ReturnType<typeof draftTokens>,
  drafts: Map<string, Draft>,
  page: (job: ImageJob, progress: boolean) => Response,
  busy: ReadonlySet<string>,
  assertEditable?: (id: string) => Promise<void>,
) {
  const job = queue.get(match[1]!);
  requestFields({ personaId: job.batch.personaId, jobId: job.id });
  if (request.method === "GET" && !match[2]) return page(job, true);
  await assertEditable?.(job.batch.personaId);
  if (busy.has(job.batch.personaId)) throw new PersonaError("conflict", copy.busy);
  if (request.method !== "POST" || !match[2]) throw new PersonaError("not_found", copy.notFound);
  if (request.headers.get("origin") !== url.origin)
    throw new PersonaError("invalid", copy.originError);
  const form = await request.formData();
  protectEditingForm(form);
  const token = tokens.decode(form.get("draft"));
  if (token.id !== job.batch.personaId) throw new PersonaError("invalid", copy.identityError);
  if (match[2] === "/delete" || match[2] === "/clear") {
    const current = drafts.get(token.id)!;
    const latest = queue.pending(token.id)
      ? current
      : {
          ...captureDocuments(form, current),
          preview: serializePersona(authorPersona(form, previewOf(current, emptyPersona))),
        };
    queue.remove(job.id, match[2] === "/clear");
    drafts.set(token.id, latest);
    return html(
      renderPage({
        record: previewOf(latest, emptyPersona),
        editing: Boolean(latest.base),
        draft: tokens.encode(latest),
        documents: documentsOf(latest),
        sheets: latest.sheets,
        tab: latest.tab,
        imageJobs: queue
          .list(token.id, "")
          .map((entry) => ({ job: entry, position: queue.position(entry.id) })),
        imageReservations: queue.reservations(token.id),
      }),
    );
  }
  const submitted = authorPersona(form, previewOf(token, emptyPersona));
  if (JSON.stringify(characterOf(submitted)) !== JSON.stringify(characterOf(job.batch.source)))
    throw new PersonaError("invalid", copy.stale);
  const ordinal = url.searchParams.get("image");
  if (!ordinal || !/^\d{1,2}$/.test(ordinal))
    throw new PersonaError("invalid", copy.imageTargetRequired);
  const prompt = readPortraitInstructions(form);
  protect(prompt);
  const retried = queue.retry(job.id, Number(ordinal), prompt, drafts.get(token.id)!);
  return new Response(null, { status: 303, headers: { Location: `/image-jobs/${retried.id}` } });
}
