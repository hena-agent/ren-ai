import type { ImageJob } from "./image-queue.ts";
import copy from "./copy.json";

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
          {job.state === "queued"
            ? `${copy.queueWaiting} · ${position + 1}번째`
            : active
              ? copy.queueRunning
              : job.state === "failed"
                ? "이미지 생성이 끝났지만 실패한 사진이 있습니다. 재시도하거나 기록을 삭제하세요."
                : copy.queueFinished}
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
                    src={task.imageUrl}
                    alt={`${copy.portraitLabels[task.style]} 사진 ${task.index + 1}`}
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
                  {copy.portraitLabels[task.style]} 사진 {task.index + 1}
                </strong>
                <span>
                  {copy.queueStates[task.state]}
                  {task.startedAt !== undefined &&
                    ` · ${Math.floor((task.durationMs ?? now - task.startedAt) / 1000)}초`}
                </span>
                {(task.state === "failed" || task.state === "blocked") && (
                  <small>요청 ID: {task.requestId ?? job.requestId}</small>
                )}
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
                  data-portrait-label={`${copy.portraitLabels[task.style]} 사진 ${task.index + 1} · ${copy.singleImageCost}`}
                  data-portrait-style={task.style}
                  data-image-index={task.index}
                  data-portrait-prompt={job.batch.prompts[task.ordinal]}
                >
                  {copy.retryImage}
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
