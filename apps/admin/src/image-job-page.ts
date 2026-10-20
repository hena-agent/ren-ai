import { PersonaError } from "@ren-ai/personas";
import { emptyPersona } from "./authoring.ts";
import { draftFields, previewOf } from "./draft.ts";
import type { Draft, draftTokens } from "./draft.ts";
import type { createImageQueue, ImageJob } from "./image-queue.ts";
import type { PageContent } from "./page.tsx";
import { retryImageInput } from "./image-actions.ts";
import { GenerationError } from "./logging.ts";
import { generationFailureMessage } from "./generation-failure.ts";
import { html } from "./html-response.ts";
import copy from "./copy.json";

export function imageJobPages(
  drafts: Map<string, Draft>,
  queue: ReturnType<typeof createImageQueue>,
  tokens: ReturnType<typeof draftTokens>,
  renderPage: (content: PageContent) => string,
) {
  const fields = (job: ImageJob) => ({
    imageJob: job,
    imageJobs: queue
      .list(job.batch.personaId, job.id)
      .map((entry) => ({ job: entry, position: queue.position(entry.id) })),
    imageReservations: queue.reservations(job.batch.personaId),
    queuePosition: queue.position(job.id),
    queueObservedAt: Date.now(),
  });
  return {
    fields,
    page: (job: ImageJob, progress: boolean) => {
      const latest = drafts.get(job.batch.personaId)!;
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
          ...draftFields(latest),
          editing: Boolean(latest.base),
          draft: tokens.encode(latest),
          seed: latest.seed,
          ...retryImageInput(latest, failed),
          imagePrompts: latest.imagePrompts,
          conversion: latest.conversion,
          ...((progress || queue.pending(job.batch.personaId)) && fields(job)),
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
    },
  };
}
