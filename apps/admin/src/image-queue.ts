import { randomUUID } from "node:crypto";
import { PersonaError, personaImages } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";
import type { ImageBatch } from "./image-batch.ts";
import type { ImageSlot } from "./image-slots.ts";
import {
  captureLogging,
  operation,
  requestId,
  reportQueueCompleted,
  reportFailure,
} from "./logging.ts";
import copy from "./copy.json";

type ImageTaskState = "waiting" | "generating" | "saving" | "completed" | "failed" | "blocked";
interface ImageTask extends ImageSlot {
  readonly ordinal: number;
  state: ImageTaskState;
  imageUrl?: string;
  startedAt?: number;
  durationMs?: number;
  requestId?: string;
}
export interface ImageJob {
  readonly id: string;
  readonly batch: ImageBatch;
  readonly tasks: readonly ImageTask[];
  state: "queued" | "running" | "completed" | "failed";
  requestId: string;
  failure?: Error;
  queuedAt: number;
  finishedAt?: number;
}
interface QueuedJob extends ImageJob {
  completion: Promise<void>;
}

export function createImageQueue(
  updated: (personaId: string, draft: Draft) => void,
  latestDraft: (personaId: string) => Draft | undefined,
) {
  const jobs = new Map<string, QueuedJob>();
  const keys = new Map<string, string>();
  const pending = new Set<string>();
  const active = (personaId: string) =>
    [...pending].map((id) => jobs.get(id)!).filter((job) => job.batch.personaId === personaId);
  const reservations = (personaId: string) => {
    const counts = { anime: 0, photo: 0 };
    for (const job of active(personaId))
      if (job.batch.intent !== "regenerate")
        for (const task of job.tasks)
          if (["waiting", "generating", "saving"].includes(task.state)) counts[task.style]++;
    return counts;
  };
  const reserve = (batch: ImageBatch, ordinals: readonly number[], replacing: boolean) => {
    if (replacing) {
      if (active(batch.personaId).length) throw new PersonaError("conflict", copy.busy);
      return;
    }
    if (batch.intent === "regenerate") return;
    const counts = reservations(batch.personaId);
    for (const image of personaImages(batch.record())) counts[image.style]++;
    for (const ordinal of ordinals) counts[batch.slots[ordinal]!.style]++;
    if (counts.anime > 6 || counts.photo > 6) throw new PersonaError("invalid", copy.galleryFull);
  };
  const publish = (job: QueuedJob, draft: Draft) => {
    updated(job.batch.personaId, draft);
  };
  const adopt = (batch: ImageBatch, ordinals: readonly number[]) => {
    if (!ordinals.length) return;
    const latest = latestDraft(batch.personaId);
    if (latest && latest.base === batch.draft().base) batch.resume(latest, ordinals);
  };
  // ponytail: FIFO and completed jobs are process-local, matching editing drafts; durable recovery needs a persisted queue.
  let tail = Promise.resolve();
  const schedule = (job: QueuedJob, ordinals: readonly number[], rebase: boolean) => {
    const captured = captureLogging();
    pending.add(job.id);
    job.requestId = requestId();
    job.queuedAt = Date.now();
    delete job.finishedAt;
    job.completion = tail
      .then(() =>
        captured(async () => {
          const start = performance.now();
          let prepared = false;
          job.state = "running";
          await operation("image.queue.batch", { jobId: job.id }, async () => {
            if (rebase) adopt(job.batch, ordinals);
            await job.batch.prepare();
            prepared = true;
            for (const ordinal of ordinals) {
              const task = job.tasks[ordinal]!;
              task.startedAt = Date.now();
              task.requestId = job.requestId;
              const imageUrl = await operation(
                "image.queue.task",
                { jobId: job.id, imageOrdinal: ordinal, style: task.style, poseIndex: task.index },
                () =>
                  job.batch.run(ordinal, (state) => {
                    task.state = state;
                  }),
              ).catch((error) => {
                task.state = "failed";
                job.failure = error instanceof Error ? error : new Error();
                return undefined;
              });
              task.durationMs = Date.now() - task.startedAt;
              if (imageUrl) {
                task.imageUrl = imageUrl;
                task.state = "completed";
              } else if (task.state !== "failed") task.state = "blocked";
              publish(job, job.batch.draft());
            }
          }).catch((error) => {
            job.failure = error instanceof Error ? error : new Error();
            for (const ordinal of ordinals) {
              const task = job.tasks[ordinal]!;
              if (task.state !== "completed") task.state = "blocked";
            }
          });
          const failed = job.tasks.some((task) => task.state !== "completed");
          const cached = latestDraft(job.batch.personaId);
          const preserved = !prepared && cached?.base === job.batch.draft().base && cached;
          publish(job, preserved || job.batch.finish(failed));
          job.state = failed ? "failed" : "completed";
          job.finishedAt = Date.now();
          const status = !failed
            ? 200
            : job.failure instanceof PersonaError
              ? { invalid: 400, not_found: 404, conflict: 409 }[job.failure.kind]
              : 503;
          reportQueueCompleted({
            jobId: job.id,
            status,
            outcome: failed ? "failed" : "completed",
            durationMs: performance.now() - start,
          });
          pending.delete(job.id);
        }),
      )
      .catch((error) =>
        captured(() => {
          try {
            reportFailure(error, { stage: "image.queue.finalize", jobId: job.id });
          } finally {
            job.failure = error instanceof Error ? error : new Error("Image completion failed");
            job.state = "failed";
            job.finishedAt = Date.now();
            pending.delete(job.id);
          }
        }),
      );
    tail = job.completion.catch(() => undefined);
  };
  const restart = (job: QueuedJob, ordinals: readonly number[]) => {
    for (const ordinal of ordinals) {
      const task = job.tasks[ordinal]!;
      task.state = "waiting";
      delete task.startedAt;
      delete task.durationMs;
      delete task.requestId;
    }
    job.state = "queued";
    schedule(job, ordinals, true);
  };
  const get = (id: string) => {
    const job = jobs.get(id);
    if (!job) throw new PersonaError("not_found", copy.notFound);
    return job;
  };
  return {
    enqueue: (key: string, batch: ImageBatch) => {
      const known = keys.get(key);
      if (known) return get(known);
      const ordinals = batch.slots.map((_, ordinal) => ordinal);
      if (batch.intent === "subportrait" || batch.intent === "regenerate") adopt(batch, ordinals);
      reserve(batch, ordinals, batch.intent === "generate" || batch.intent === "portrait");
      const reserved = reservations(batch.personaId);
      const job: QueuedJob = {
        id: randomUUID(),
        batch,
        requestId: requestId(),
        state: "queued",
        queuedAt: Date.now(),
        completion: Promise.resolve(),
        tasks: batch.slots.map((slot, ordinal) => ({
          ...slot,
          index: slot.index + (batch.intent === "subportrait" ? reserved[slot.style] : 0),
          ordinal,
          state: "waiting",
        })),
      };
      jobs.set(job.id, job);
      keys.set(key, job.id);
      schedule(job, ordinals, batch.intent === "subportrait" || batch.intent === "regenerate");
      return job;
    },
    get,
    find: (key: string) => {
      const id = keys.get(key);
      return id ? get(id) : undefined;
    },
    pending: (personaId: string) => active(personaId)[0]?.id,
    list: (personaId: string, selectedId: string) =>
      [...jobs.values()].filter(
        (job) =>
          job.batch.personaId === personaId &&
          (pending.has(job.id) || job.id === selectedId || job.state === "failed"),
      ),
    reservations,
    position: (id: string) => [...pending].indexOf(id),
    wait: async (job: QueuedJob) => {
      await job.completion;
      return job;
    },
    retryFailed: (id: string, editing: Draft) => {
      const job = get(id);
      if (pending.has(job.id)) throw new PersonaError("conflict", copy.busy);
      const ordinals = job.tasks
        .filter((task) => task.state === "failed" || task.state === "blocked")
        .map((task) => task.ordinal);
      job.batch.resume(editing, ordinals);
      reserve(job.batch, ordinals, false);
      for (const ordinal of ordinals) job.batch.setPrompt(ordinal, job.batch.prompts[ordinal]!);
      restart(job, ordinals);
      return job;
    },
    retry: (id: string, ordinal: number, prompt: string, editing: Draft) => {
      const job = get(id);
      const task = job.tasks[ordinal];
      if (!task || (task.state !== "failed" && task.state !== "blocked"))
        throw new PersonaError("invalid", copy.imageTargetRequired);
      if (pending.has(job.id)) throw new PersonaError("conflict", copy.busy);
      job.batch.resume(editing, [ordinal]);
      reserve(job.batch, [ordinal], false);
      job.batch.setPrompt(ordinal, prompt);
      restart(job, [ordinal]);
      return job;
    },
  };
}
