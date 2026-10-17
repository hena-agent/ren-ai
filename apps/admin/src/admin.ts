import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { decodePersona, PersonaError, serializePersona } from "@ren-ai/personas";
import type { PersonaStore, PersonaRecord } from "@ren-ai/personas";
import {
  authorPersona,
  descriptionOf,
  emptyPersona,
  readIntent,
  selectedGender,
  characterOf,
} from "./authoring.ts";
import { restoreDraft, draftTokens, previewOf, documentsOf, captureDocuments } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { renderPage } from "./page.tsx";
import type { PageContent } from "./page.tsx";
import copy from "./copy.json";
import { generateTextDraft } from "./generation-workflows.ts";
import { deletePortrait, setMainPortrait } from "./regenerate-portrait.ts";
import { createImageQueue } from "./image-queue.ts";
import type { ImageJob, DurableQueue } from "./image-queue.ts";
import { createImageBatch, restoreImageBatch } from "./image-batch.ts";
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
  reportFailure,
  requestFields,
  requestId,
  GenerationError,
} from "./logging.ts";
import { versionedPersona } from "@ren-ai/personas";
import { createResources } from "./resources.ts";
import { assertSnapshot } from "./snapshot.ts";
import type { AdminOptions } from "./admin-options.ts";
import { contactRoutes } from "./contact-routes.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { html } from "./html-response.ts";
import { generationFailureMessage } from "./generation-failure.ts";
import { imageJobRoute } from "./image-job-routes.ts";
import { uploadRoute } from "./upload-route.ts";
import { versionRoutes } from "./version-routes.ts";
const documentFields = (draft: Draft) => ({
  documents: documentsOf(draft),
  tab: draft.tab,
  showIdea: Boolean(draft.characterPending),
  improvementInput: draft.improvementInput,
});
export function createAdmin(
  store: PersonaStore,
  password: string,
  stylesheet: string,
  {
    generator,
    script,
    log,
    persistence,
    management,
    catalogPending,
    localImages = true,
  }: AdminOptions = {},
) {
  if (!password.trim()) throw new Error("ADMIN_PASSWORD is required");
  const expected = createHash("sha256")
    .update(`Basic ${Buffer.from(`admin:${password}`).toString("base64")}`)
    .digest();
  const tokens = draftTokens(password);
  const privateResource = createResources(
    store,
    tokens,
    stylesheet,
    script,
    localImages,
    (content) => html(renderPage(content)),
  );
  const busy = new Set<string>();
  const subDrafts = new Map<string, Draft>(persistence?.saved?.drafts);
  const durable: DurableQueue | undefined = persistence
    ? {
        saved: persistence.saved?.queue,
        checkpoint: () =>
          persistence.checkpoint({ drafts: [...subDrafts], queue: queue.snapshot() }),
        restoreBatch: (snapshot) => restoreImageBatch(snapshot, generator!, store),
      }
    : undefined;
  const queue = createImageQueue(
    (id, next) => subDrafts.set(id, next),
    (id) => subDrafts.get(id),
    durable,
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
    const message =
      error instanceof PersonaError
        ? error.message
        : error instanceof GenerationError
          ? generationFailureMessage(error)
          : undefined;
    const active = draft && queue.pending(draft.id);
    const content: PageContent =
      record && draft
        ? {
            record,
            ...documentFields(draft),
            draft: tokens.encode(draft),
            editing: Boolean(draft.base),
            seed: draft.seed,
            portraitInstructions: imagePromptOf(draft),
            portraitOperation: draft.portraitOperation,
            imageCount: draft.imageCount,
            imagePrompts: draft.imagePrompts,
            conversion: draft.conversion,
            ...(active && queueFields(queue.get(active))),
          }
        : { personas: [] };
    return html(
      renderPage({
        ...content,
        error: `${message ?? copy.failure} (요청 ID: ${requestId()})`,
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
        ...documentFields(draft),
        editing: Boolean(draft.base),
        draft: tokens.encode(draft),
        seed: draft.seed,
        ...retryImageInput(draft, true),
        conversion: draft.conversion,
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
      await assertSnapshot(store, draft);
      if (intent === "save") {
        const valid = decodePersona(versionedPersona(persona));
        if (valid.published && !valid.imageUrl)
          throw new PersonaError("invalid", "공개하려면 소개와 프로필 이미지가 필요합니다.");
        const documents = documentsOf(draft);
        const saved = await operation("persona.save", {}, () =>
          store.save(valid, documents, {
            persona: draft.base,
            ...(draft.initial?.base && { initial: draft.initial.base }),
            ...(draft.legacySource && { legacySource: draft.legacySource }),
          }),
        );
        subDrafts.set(draft.id, {
          id: draft.id,
          base: serializePersona(saved),
          preview: serializePersona(saved),
          initial: { base: documents, preview: documents },
        });
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/personas/${valid.id}?saved=1${draft.tab && draft.tab !== "persona" ? `&tab=${draft.tab}` : ""}`,
          },
        });
      }
      if (intent === "delete-image" || intent === "set-main") {
        const next =
          intent === "set-main"
            ? setMainPortrait(persona, draft, submittedKey)
            : deletePortrait(persona, draft, submittedKey);
        subDrafts.set(draft.id, next);
        return html(
          renderPage({
            record: previewOf(next, emptyPersona),
            ...documentFields(next),
            editing: Boolean(next.base),
            draft: tokens.encode(next),
          }),
        );
      }
      if (intent === "introduction" && !persona.bio)
        throw new PersonaError("invalid", copy.regenerateRequired);
      if (intent === "inspect")
        return html(
          renderPage({
            record: persona,
            ...documentFields(draft),
            editing: Boolean(draft.base),
            draft: tokens.encode(draft),
            conversion: draft.conversion,
          }),
        );
      if (!generator) return unconfigured(persona, draft);
      const next = await generateTextDraft(persona, draft, intent, generator);
      await assertSnapshot(store, draft);
      subDrafts.set(draft.id, next);
      return html(
        renderPage({
          record: previewOf(next, emptyPersona),
          ...documentFields(next),
          editing: Boolean(draft.base),
          draft: tokens.encode(next),
          seed: next.seed,
          conversion: next.conversion,
        }),
      );
    } finally {
      busy.delete(draft.id);
    }
  };

  const jobPage = (job: ImageJob, progress: boolean) => {
    const latest = subDrafts.get(job.batch.personaId)!;
    const failed = job.state === "failed";
    const record =
      job.state !== "completed" && latest.preview === job.batch.draft().preview
        ? job.batch.record()
        : previewOf(latest, emptyPersona);
    const cause = job.failure;
    const invalid = cause instanceof PersonaError;
    const detail = invalid
      ? cause.message
      : cause instanceof GenerationError
        ? generationFailureMessage(cause)
        : undefined;
    return html(
      renderPage({
        record,
        ...documentFields(latest),
        editing: Boolean(latest.base),
        draft: tokens.encode(latest),
        seed: latest.seed,
        ...retryImageInput(latest, failed),
        imagePrompts: latest.imagePrompts,
        conversion: latest.conversion,
        ...((progress || queue.pending(job.batch.personaId)) && queueFields(job)),
        ...(failed && {
          error: `${detail ?? copy.failure} ${copy.partialGenerationFailure} (요청 ID: ${job.requestId})`,
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
    const current = subDrafts.get(draft.id);
    const pending = queue.pending(draft.id);
    if (
      pending &&
      current &&
      (JSON.stringify(documentsOf(draft)) !== JSON.stringify(documentsOf(current)) ||
        JSON.stringify(characterOf(persona)) !==
          JSON.stringify(characterOf(queue.get(pending).batch.source)))
    )
      throw new PersonaError("conflict", copy.busy);
    if (!known) await assertSnapshot(store, draft);
    if (!known && !queue.pending(draft.id)) {
      subDrafts.set(draft.id, draft);
    }
    const job =
      known ??
      queue.enqueue(
        paidKey,
        createImageBatch(persona, draft, intent, params, key, generator, store),
      );
    if (persistence || request.headers.get("x-image-queue") === "1")
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
      draft = captureDocuments(form, draft);
      const previous = previewOf(draft, emptyPersona);
      if (intent === "character") {
        const gender = selectedGender(form, previous);
        record = { ...previous, description: descriptionOf(previous), ...(gender && { gender }) };
        const seed = form.get("seed");
        if (typeof seed !== "string" || !seed.trim())
          throw new PersonaError("invalid", copy.seedRequired);
        draft = { ...draft, seed: seed.trim(), characterPending: true };
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

  const editorPage = async (
    record: PersonaRecord | undefined,
    editing: boolean,
    saved: boolean,
    tab: string | null,
  ) => {
    if (record) {
      const active = queue.pending(record.id);
      if (active) return jobPage(queue.get(active), true);
    }
    let draft = record ? restoreDraft(record, editing, subDrafts.get(record.id)) : undefined;
    if (draft && editing && !draft.initial) {
      const initial = await store.initial(draft.id);
      draft = { ...draft, initial: initial ? { base: initial, preview: initial } : {} };
    }
    if (draft) subDrafts.set(draft.id, draft);
    const content: PageContent = record
      ? {
          record: previewOf(draft!, emptyPersona),
          ...documentFields(draft!),
          tab: tab === "persona" || tab === "state" || tab === "memory" ? tab : draft!.tab,
          editing,
          draft: tokens.encode(draft!),
          seed: draft!.seed,
          portraitInstructions: imagePromptOf(draft!),
          portraitOperation: draft!.portraitOperation,
          imageCount: draft!.imageCount,
          imagePrompts: draft!.imagePrompts,
          conversion: draft!.conversion,
          imageJobs: queue
            .list(record.id, "")
            .map((job) => ({ job, position: queue.position(job.id) })),
          changed:
            draft!.preview !== draft!.base ||
            JSON.stringify(draft!.initial?.preview) !== JSON.stringify(draft!.initial?.base),
        }
      : { personas: await operation("persona.list", {}, store.list) };
    return html(renderPage({ ...content, saved, catalogPending: await catalogPending?.() }));
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
      if (["/waitlist", "/first-contacts"].includes(url.pathname))
        return contactRoutes(request, management);
      if (url.pathname.startsWith("/conversations"))
        return conversationRoutes(request, management?.conversations);
      if (url.pathname === "/upload-image")
        return await uploadRoute(request, url, store, tokens, subDrafts, busy, queue.pending);
      const versionResponse = await versionRoutes(request, url, {
        store,
        tokens,
        drafts: subDrafts,
        busy,
        pending: queue.pending,
      });
      if (versionResponse) return versionResponse;
      const resource = request.method === "GET" ? await privateResource(url.pathname) : undefined;
      if (resource) return resource;
      const jobMatch = /^\/image-jobs\/([0-9a-f-]+)(\/(?:retry|delete|clear))?$/.exec(url.pathname);
      if (jobMatch)
        return await imageJobRoute(request, url, jobMatch, queue, tokens, subDrafts, jobPage);
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
      return await editorPage(
        record,
        Boolean(match),
        url.searchParams.get("saved") === "1",
        url.searchParams.get("tab"),
      );
    } catch (error) {
      return failure(error);
    }
  };
  const fetch = (request: Request) =>
    loggedRequest(
      request,
      async () => {
        const response = await handle(request);
        try {
          if (durable) await operation("editing.checkpoint", {}, durable.checkpoint);
          if (persistence && queue.next())
            await operation("image.queue.wake", {}, persistence.wake);
          return response;
        } catch (error) {
          return failure(error);
        }
      },
      log,
    );
  return Object.assign(fetch, { runNext: queue.runNext, nextJob: queue.next });
}
