import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { decodePersona, parsePersona } from "@ren-ai/personas";
import type { AdminSnapshot } from "./admin-state.ts";
import type { Draft } from "./draft.ts";
import type { ImageBatchSnapshot } from "./image-batch.ts";
import { reportFailure, validationFailure } from "./logging.ts";

function validateDraft(draft: Draft) {
  for (const source of [draft.base, draft.preview]) if (source) parsePersona(draft.id, source);
}

/** Unreadable editing state is retained verbatim, never replayed or silently discarded. */
export async function recoverEditing(
  storage: DurableObjectStorage,
  saved: AdminSnapshot,
  restore: (batch: ImageBatchSnapshot) => object,
): Promise<AdminSnapshot> {
  const affected = new Set<string>();
  const inspect = (personaId: string, validate: () => void) => {
    const started = performance.now();
    try {
      validate();
    } catch (cause) {
      affected.add(personaId);
      reportFailure(
        validationFailure(
          "Editing record archived for operator recovery",
          {
            stage: "editing.restore",
            code: "editing_restore_failed",
          },
          cause,
        ),
        { personaId, stage: "editing.restore", durationMs: performance.now() - started },
      );
    }
  };
  for (const [id, draft] of saved.drafts) inspect(id, () => validateDraft(draft));
  for (const job of saved.queue.jobs)
    inspect(job.batch.source.id, () => {
      decodePersona(job.batch.current);
      validateDraft(job.batch.original);
      validateDraft(job.batch.latest);
      if (job.batch.expectedBase) parsePersona(job.batch.source.id, job.batch.expectedBase);
      restore(job.batch);
    });
  const drafts = saved.drafts.filter(([id]) => !affected.has(id));
  const jobs = saved.queue.jobs.filter((job) => !affected.has(job.batch.source.id));
  const pending = saved.queue.pending.filter((id) => jobs.some((job) => job.id === id));
  if (affected.size)
    await storage.transaction(async (transaction) => {
      const archive = `recovery:${crypto.randomUUID()}`;
      for (const [id, draft] of saved.drafts)
        if (affected.has(id)) {
          await transaction.put(`${archive}:draft:${id}`, draft);
          await transaction.delete(`draft:${id}`);
        }
      for (const job of saved.queue.jobs)
        if (affected.has(job.batch.source.id)) {
          await transaction.put(`${archive}:job:${job.id}`, job);
          await transaction.delete(`job:${job.id}`);
        }
      await transaction.put("pending", pending);
    });
  return { drafts, queue: { jobs, pending, keys: saved.queue.keys } };
}

export async function downloadEditingRecovery(storage: DurableObjectStorage) {
  const records = await storage.list<Draft | AdminSnapshot["queue"]["jobs"][number]>({
    prefix: "recovery:",
  });
  return Response.json([...records], {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="editing-recovery.json"',
    },
  });
}
