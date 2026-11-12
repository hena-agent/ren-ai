import type { ImageAttempt, ImageFailure } from "./image-attempt.ts";
import type { ImageJob } from "./image-queue.ts";

const clock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function Time({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{clock.format(value)} KST</time>;
}
function Failure({ failure }: { failure: ImageFailure }) {
  return (
    <div className="queue-failure">
      <p>{failure.summary}</p>
      <small>
        단계: <code>{failure.stage}</code>
        {failure.code && (
          <>
            {" "}
            · 코드: <code>{failure.code}</code>
          </>
        )}
        {failure.status !== undefined && <> · 공급자 HTTP {failure.status}</>} · {failure.causeName}
        {failure.causeCode && (
          <>
            {" "}
            · 원인 코드: <code>{failure.causeCode}</code>
          </>
        )}
      </small>
    </div>
  );
}
const states = {
  queued: "대기",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
  blocked: "진행 차단",
  interrupted: "중단 · 결과 불확실",
};

function Attempt({
  attempt,
  ordinal,
  now,
}: {
  attempt: ImageAttempt;
  ordinal: number;
  now: number;
}) {
  const elapsed =
    attempt.startedAt !== undefined &&
    (attempt.finishedAt ?? (attempt.state === "running" ? now : undefined));
  return (
    <li>
      <strong>
        {ordinal}차 시도 · {attempt.kind === "resume" ? "기존 접수 결과 조회·저장" : "생성 시도"} ·{" "}
        {states[attempt.state]}
      </strong>
      <dl className="queue-attempt-times">
        <dt>등록</dt>
        <dd>
          <Time value={attempt.queuedAt} />
        </dd>
        <dt>실행 시작</dt>
        <dd>
          {attempt.startedAt !== undefined ? (
            <>
              <Time value={attempt.startedAt} /> · 대기{" "}
              {Math.floor((attempt.startedAt - attempt.queuedAt) / 1000)}초
            </>
          ) : (
            "실행하지 않음"
          )}
        </dd>
        {attempt.finishedAt !== undefined && (
          <>
            <dt>{attempt.state === "completed" ? "완료" : "실패"}</dt>
            <dd>
              <Time value={attempt.finishedAt} />
            </dd>
          </>
        )}
        {attempt.recoveredAt !== undefined && (
          <>
            <dt>중단 확인</dt>
            <dd>
              <Time value={attempt.recoveredAt} /> · 실제 중단 시각은 알 수 없음
            </dd>
          </>
        )}
        {elapsed !== false && elapsed !== undefined && (
          <>
            <dt>처리 시간</dt>
            <dd>{Math.floor((elapsed - attempt.startedAt!) / 1000)}초</dd>
          </>
        )}
      </dl>
      {attempt.failure && <Failure failure={attempt.failure} />}
      <small>요청 ID: {attempt.requestId}</small>
    </li>
  );
}

export function ImageAttemptHistory({
  task,
  job,
  now,
}: {
  task: ImageJob["tasks"][number];
  job: ImageJob;
  now: number;
}) {
  if (task.attempts?.length)
    return (
      <details className="queue-attempt-history" open={task.state !== "completed"}>
        <summary>시도 이력 {task.attempts.length}회</summary>
        <ol>
          {task.attempts.map((attempt, index) => (
            <Attempt key={index} attempt={attempt} ordinal={index + 1} now={now} />
          ))}
        </ol>
      </details>
    );
  const ended =
    task.startedAt !== undefined && task.durationMs !== undefined
      ? task.startedAt + task.durationMs
      : undefined;
  return (
    <div className="queue-attempt-history">
      <dl className="queue-attempt-times">
        <dt>등록</dt>
        <dd>
          <Time value={job.queuedAt} />
        </dd>
        {task.startedAt !== undefined && (
          <>
            <dt>실행 시작</dt>
            <dd>
              <Time value={task.startedAt} />
            </dd>
          </>
        )}
        {ended !== undefined && (
          <>
            <dt>{task.state === "completed" ? "완료" : "실패"}</dt>
            <dd>
              <Time value={ended} /> · {Math.floor(task.durationMs! / 1000)}초
            </dd>
          </>
        )}
      </dl>
      {job.diagnostic ? (
        <Failure failure={job.diagnostic} />
      ) : (
        <small>
          시도별 상세 진단 수집 전 기록입니다. 저장되지 않은 원인·중단 시각은 추정하지 않습니다.
        </small>
      )}
    </div>
  );
}
