import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { decodePersona, PersonaError, serializePersona } from "@ren-ai/personas";
import type { createPersonaStore, PersonaRecord } from "@ren-ai/personas";
import {
  authorPersona,
  descriptionOf,
  emptyPersona,
  readIntent,
  requireMatchingProfile,
  selectedGender,
  readPortraitInstructions,
  characterOf,
} from "./authoring.ts";
import { restoreDraft, draftTokens, previewOf } from "./draft.ts";
import type { Draft } from "./draft.ts";
import type { ProfileGenerator } from "./generation.ts";
import { renderPage } from "./page.tsx";
import type { PageContent } from "./page.tsx";
import copy from "./copy.json";
import { generateTextDraft } from "./generation-workflows.ts";
import { deletePortrait } from "./regenerate-portrait.ts";
import { createImageQueue } from "./image-queue.ts";
import type { ImageJob } from "./image-queue.ts";
import { createImageBatch } from "./image-batch.ts";
import { isImageIntent } from "./image-slots.ts";
import type { ImageIntent } from "./image-slots.ts";
import {
  capturePortraitInput,
  imagePromptOf,
  imageSubmission,
  imageRequestKey,
  retryImageInput,
  protectEditingForm,
} from "./image-actions.ts";
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
        "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  // ponytail: retain the latest paid additions per persona in this process; persistent idempotency if drafts must survive restarts.
  const subDrafts = new Map<string, Draft>();
  const queue = createImageQueue(
    (id, next) => subDrafts.set(id, next),
    (id) => subDrafts.get(id),
  );
  const queueFields = (job: ImageJob) => ({
    imageJob: job,
    imageJobs: queue.list(job.batch.personaId, job.id).map((entry) => ({
      job: entry,
      position: queue.position(entry.id),
    })),
    imageReservations: queue.reservations(job.batch.personaId),
    queuePosition: queue.position(job.id),
    queueObservedAt: Date.now(),
  });
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow request, generation and storage failures before responding
  const failure = (error: unknown, record?: PersonaRecord, draft?: Draft) => {
    reportFailure(error, { stage: "request" }, error instanceof PersonaError ? "warn" : "error");
    const active = draft && queue.pending(draft.id);
    const content: PageContent =
      record && draft
        ? {
            record,
            draft: tokens.encode(draft),
            editing: Boolean(draft.base),
            seed: draft.seed,
            portraitInstructions: imagePromptOf(draft),
            portraitOperation: draft.portraitOperation,
            imageCount: draft.imageCount,
            imagePrompts: draft.imagePrompts,
            profileSource: previewOf(draft, emptyPersona),
            ...(active && queueFields(queue.get(active))),
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

  const unconfigured = (persona: PersonaRecord, draft: Draft) => {
    reportFailure(new Error("Profile generator is not configured"), {
      stage: "generation.configuration",
    });
    return html(
      renderPage({
        record: persona,
        editing: Boolean(draft.base),
        draft: tokens.encode(draft),
        seed: draft.seed,
        ...retryImageInput(draft, true),
        profileSource: previewOf(draft, emptyPersona),
        error: `${copy.generationUnavailable} (요청 ID: ${requestId()})`,
      }),
      503,
    );
  };

  const execute = async (
    persona: ReturnType<typeof authorPersona>,
    draft: Draft,
    intent: Exclude<ReturnType<typeof readIntent>, ImageIntent>,
    submittedKey: string,
  ) => {
    if (busy.has(draft.id) || queue.pending(draft.id))
      throw new PersonaError("conflict", copy.busy);
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
        subDrafts.set(draft.id, {
          id: draft.id,
          base: serializePersona(valid),
          preview: serializePersona(valid),
        });
        return new Response(null, {
          status: 303,
          headers: { Location: `/personas/${valid.id}?saved=1` },
        });
      }
      if (intent === "delete-image") {
        requireMatchingProfile(persona, previewOf(draft, emptyPersona));
        const next = deletePortrait(persona, draft, submittedKey);
        subDrafts.set(draft.id, next);
        return html(
          renderPage({
            record: previewOf(next, emptyPersona),
            editing: Boolean(next.base),
            draft: tokens.encode(next),
            profileSource: previewOf(next, emptyPersona),
          }),
        );
      }
      if (intent === "introduction") {
        if (!persona.bio) throw new PersonaError("invalid", copy.regenerateRequired);
        requireMatchingProfile(persona, previewOf(draft, emptyPersona));
      }
      if (!generator) return unconfigured(persona, draft);
      const next = await generateTextDraft(persona, draft, intent, generator);
      subDrafts.set(draft.id, next);
      return html(
        renderPage({
          record: previewOf(next, emptyPersona),
          editing: Boolean(draft.base),
          draft: tokens.encode(next),
          seed: next.seed,
          profileSource: previewOf(next, emptyPersona),
        }),
      );
    } finally {
      busy.delete(draft.id);
    }
  };

  const jobPage = (job: ImageJob, progress: boolean) => {
    const latest = subDrafts.get(job.batch.personaId) ?? job.batch.draft();
    const failed = job.state === "failed";
    const record =
      job.state !== "completed" && latest.preview === job.batch.draft().preview
        ? job.batch.record()
        : previewOf(latest, emptyPersona);
    const cause = job.failure;
    const invalid = cause instanceof PersonaError;
    return html(
      renderPage({
        record,
        editing: Boolean(latest.base),
        draft: tokens.encode(latest),
        seed: latest.seed,
        ...retryImageInput(latest, failed),
        imagePrompts: latest.imagePrompts,
        profileSource: previewOf(latest, emptyPersona),
        ...((progress || queue.pending(job.batch.personaId)) && queueFields(job)),
        ...(failed && {
          error: `${invalid ? job.failure!.message : copy.failure} ${copy.partialGenerationFailure} (요청 ID: ${job.requestId})`,
        }),
      }),
      progress || !failed
        ? 200
        : invalid
          ? { invalid: 400, not_found: 404, conflict: 409 }[cause.kind]
          : 503,
    );
  };

  const enqueueImages = async (
    request: Request,
    persona: ReturnType<typeof authorPersona>,
    draft: Draft,
    intent: ImageIntent,
    params: URLSearchParams,
    key: string,
    paidKey: string,
  ) => {
    if (!generator) return unconfigured(persona, draft);
    if (busy.has(draft.id)) throw new PersonaError("conflict", copy.busy);
    const known = queue.find(paidKey);
    if (!known && draft.base && serializePersona(await store.get(draft.id)) !== draft.base)
      throw new PersonaError("conflict", copy.stale);
    const job =
      known ??
      queue.enqueue(
        paidKey,
        createImageBatch(persona, draft, intent, params, key, generator, store),
      );
    if (request.headers.get("x-image-queue") === "1")
      return new Response(null, { status: 303, headers: { Location: `/image-jobs/${job.id}` } });
    if (known && job.state === "failed")
      queue.retryFailed(job.id, subDrafts.get(job.batch.personaId)!);
    await queue.wait(job);
    return jobPage(job, false);
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
      protectEditingForm(form);
      requestFields({ personaId: draft.id });
      if ((id && (id !== draft.id || !draft.base)) || (!id && draft.base))
        throw new PersonaError("invalid", copy.identityError);
      const intent = readIntent(form);
      requestFields({ intent });
      const submission = imageSubmission(draft, subDrafts.get(draft.id), intent, url.searchParams);
      const submittedKey = submission.key;
      draft = submission.draft;
      const previous = previewOf(draft, emptyPersona);
      if (intent === "character") {
        const gender = selectedGender(form, previous);
        record = { ...previous, description: descriptionOf(previous), ...(gender && { gender }) };
        const seed = form.get("seed");
        if (typeof seed !== "string" || !seed.trim())
          throw new PersonaError("invalid", copy.seedRequired);
        draft = { ...draft, seed: seed.trim() };
      } else {
        record = authorPersona(form, previous);
        if (!record.name || !record.description)
          throw new PersonaError("invalid", copy.characterRequired);
      }
      if (isImageIntent(intent)) draft = capturePortraitInput(draft, form, intent, submittedKey);
      const paidKey = imageRequestKey(request, draft.id, intent, form, url.search);
      if (isImageIntent(intent))
        return await enqueueImages(
          request,
          record,
          draft,
          intent,
          url.searchParams,
          submittedKey,
          paidKey,
        );
      return await execute(record, draft, intent, submittedKey);
    } catch (error) {
      return failure(error, record, draft);
    }
  };

  const handleJob = async (request: Request, url: URL, match: RegExpExecArray) => {
    const job = queue.get(match[1]!);
    requestFields({ personaId: job.batch.personaId, jobId: job.id });
    if (request.method === "GET" && !match[2]) return jobPage(job, true);
    if (request.method !== "POST" || !match[2])
      return html(renderPage({ personas: [], error: copy.notFound }), 404);
    if (request.headers.get("origin") !== url.origin)
      throw new PersonaError("invalid", copy.originError);
    const form = await request.formData();
    protectEditingForm(form);
    const token = tokens.decode(form.get("draft"));
    if (token.id !== job.batch.personaId) throw new PersonaError("invalid", copy.identityError);
    const submitted = authorPersona(form, previewOf(token, emptyPersona));
    if (JSON.stringify(characterOf(submitted)) !== JSON.stringify(characterOf(job.batch.source)))
      throw new PersonaError("invalid", copy.regenerateRequired);
    const ordinal = url.searchParams.get("image");
    if (!ordinal || !/^\d{1,2}$/.test(ordinal))
      throw new PersonaError("invalid", copy.imageTargetRequired);
    const prompt = readPortraitInstructions(form);
    protect(prompt);
    const retried = queue.retry(
      job.id,
      Number(ordinal),
      prompt,
      subDrafts.get(job.batch.personaId)!,
    );
    return new Response(null, { status: 303, headers: { Location: `/image-jobs/${retried.id}` } });
  };

  const editorPage = async (
    record: PersonaRecord | undefined,
    editing: boolean,
    saved: boolean,
  ) => {
    if (record) {
      const active = queue.pending(record.id);
      if (active) return jobPage(queue.get(active), true);
    }
    const draft = record ? restoreDraft(record, editing, subDrafts.get(record.id)) : undefined;
    if (draft) subDrafts.set(draft.id, draft);
    const content: PageContent = record
      ? {
          record: previewOf(draft!, emptyPersona),
          editing,
          draft: tokens.encode(draft!),
          seed: draft!.seed,
          portraitInstructions: imagePromptOf(draft!),
          portraitOperation: draft!.portraitOperation,
          imageCount: draft!.imageCount,
          imagePrompts: draft!.imagePrompts,
          profileSource: previewOf(draft!, emptyPersona),
        }
      : { personas: await operation("persona.list", {}, store.list) };
    return html(renderPage({ ...content, saved }));
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
      const jobMatch = /^\/image-jobs\/([0-9a-f-]+)(\/retry)?$/.exec(url.pathname);
      if (jobMatch) return await handleJob(request, url, jobMatch);
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
      return await editorPage(record, Boolean(match), url.searchParams.get("saved") === "1");
    } catch (error) {
      return failure(error);
    }
  };
  return (request: Request) => loggedRequest(request, () => handle(request), log);
}
