import { thumbnailUrl } from "@ren-ai/personas/image-url";
import type { ImageJob } from "./image-queue.ts";
import copy from "./copy.json";
import { isSheetIntent } from "./image-slots.ts";
import { ImageAttemptHistory } from "./image-attempt-history.tsx";
import { faceGenerationLabels } from "./rig-face.ts";

function elapsed(task: ImageJob["tasks"][number], now: number) {
  if (task.startedAt === undefined) return "";
  const duration =
    task.durationMs ??
    (task.state === "generating" || task.state === "saving" ? now - task.startedAt : undefined);
  return duration === undefined ? "" : ` · ${Math.floor(duration / 1000)}초`;
}

function jobStatus(job: ImageJob, active: boolean, position: number) {
  if (job.state === "queued") return `${copy.queueWaiting} · ${position + 1}번째`;
  if (active) return copy.queueRunning;
  if (job.state !== "failed") return copy.queueFinished;
  if (
    job.tasks.some((task) => task.attempts?.at(-1)?.state === "interrupted" || task.recoveryPending)
  )
    return "실행이 중단되어 최종 결과가 불확실합니다. 기존 접수 결과를 확인하세요. 새 유료 생성을 자동으로 반복하지 않습니다.";
  if (job.batch.intent === "rig-layers")
    return "레이어 분리 또는 저장에 실패했습니다. 원화·이전 레이어는 유지됩니다.";
  return "이미지 생성이 끝났지만 실패한 사진이 있습니다. 재시도하거나 기록을 삭제하세요.";
}

export function ImageJobPanel({
  job,
  position,
  now,
  titleId = "image-queue-title",
}: {
  job: ImageJob;
  position: number;
  now: number;
  titleId?: string;
}) {
  const active = job.state === "queued" || job.state === "running";
  const completed = job.tasks.filter((task) => task.state === "completed").length;
  const snapshot = job.batch.snapshot();
  const assetTarget = snapshot.original.rigArtwork?.target;
  const face = snapshot.original.rigArtwork?.face;
  const asset = face
    ? `얼굴 · ${faceGenerationLabels[face.kind]}`
    : assetTarget
      ? { body: "기본 몸", outfit: "의상" }[assetTarget]
      : "원화";
  const target = (index: number) =>
    job.batch.intent === "rig-layers"
      ? `${asset} 레이어 분리 · Seedream 5 Pro`
      : job.batch.intent === "rig-artwork"
        ? `rig-c ${asset} · ${snapshot.original.rigArtwork!.selection!.providerName} / ${snapshot.original.rigArtwork!.selection!.name}`
        : isSheetIntent(job.batch.intent)
          ? "인물 시트"
          : `사진 ${index + 1}`;
  return (
    <section
      className="image-queue"
      data-image-job={job.id}
      data-job-active={String(active)}
      aria-labelledby={titleId}
    >
      <div>
        <div className="queue-heading">
          <div>
            <p className="eyebrow">IMAGE QUEUE</p>
            <h2 id={titleId} tabIndex={-1}>
              {copy.queueTitle}
            </h2>
          </div>
          <div className="queue-totals">
            <span className="queue-count">
              {completed} / {job.tasks.length}
            </span>
            <small>{Math.floor(((job.finishedAt ?? now) - job.queuedAt) / 1000)}초 경과</small>
          </div>
        </div>
        <output className="hint" data-queue-status aria-live="polite">
          {jobStatus(job, active, position)}
        </output>
        {!active && (
          <div className="form-actions">
            <button
              type="submit"
              form="persona-editor"
              formAction={`/image-jobs/${job.id}/delete`}
              className="secondary"
            >
              기록 삭제
            </button>
            <button
              type="submit"
              form="persona-editor"
              formAction={`/image-jobs/${job.id}/clear`}
              className="secondary"
            >
              종료된 기록 모두 삭제
            </button>
          </div>
        )}
        <ol className="queue-items">
          {job.tasks.map((task) => (
            <li className="queue-item" key={task.ordinal} data-state={task.state}>
              <div className="queue-thumbnail">
                {task.imageUrl ? (
                  <img
                    src={thumbnailUrl(task.imageUrl)}
                    alt={`${copy.portraitLabels[task.style]} ${target(task.index)}`}
                    width={48}
                    height={60}
                    loading="lazy"
                  />
                ) : (
                  <span>{task.ordinal + 1}</span>
                )}
              </div>
              <div className="queue-item-content">
                <strong>
                  {copy.portraitLabels[task.style]} {target(task.index)}
                </strong>
                <span>
                  {copy.queueStates[task.state]}
                  {elapsed(task, now)}
                </span>
                {(task.state === "failed" || task.state === "blocked") && (
                  <small className="queue-request-id">
                    요청 ID: {task.requestId ?? job.requestId}
                  </small>
                )}
                <ImageAttemptHistory task={task} job={job} now={now} />
              </div>
              {!active && (task.state === "failed" || task.state === "blocked") && (
                <button
                  className="secondary"
                  form="persona-editor"
                  type="submit"
                  name="intent"
                  value="retry-image"
                  formAction={`/image-jobs/${job.id}/retry?image=${task.ordinal}`}
                  data-portrait-operation={`retry:${job.id}:${task.ordinal}`}
                  data-portrait-label={`${copy.portraitLabels[task.style]} ${target(task.index)} · ${copy.singleImageCost}`}
                  data-portrait-style={task.style}
                  data-image-index={task.index}
                  data-portrait-prompt={job.batch.prompts[task.ordinal]}
                  data-rig-artwork-target={job.batch.intent === "rig-artwork" ? "true" : undefined}
                  data-artwork-target={snapshot.original.rigArtwork?.target}
                  data-rig-face-action={face?.kind}
                  data-layerize-target={job.batch.intent === "rig-layers" ? "true" : undefined}
                  data-layerize-retry={job.batch.intent === "rig-layers" ? "true" : undefined}
                  data-layerize-cached={snapshot.layerize ? "true" : undefined}
                  data-layerize-price={snapshot.original.rigArtwork?.layerize?.price}
                >
                  {job.batch.intent === "rig-layers" ? "분리/저장 재시도" : copy.retryImage}
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
