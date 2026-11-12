import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fromPartial } from "@total-typescript/shoehorn";
import { ImageAttemptHistory } from "./image-attempt-history.tsx";
import type { ImageJob } from "./image-queue.ts";
import type { ImageAttempt, ImageFailure } from "./image-attempt.ts";

const failure: ImageFailure = {
  summary: "공급자 요청 실패",
  stage: "rig.layers.generate",
  code: "http_error",
  status: 422,
  causeName: "ProviderError",
  causeCode: "input_failed",
};
const job = fromPartial<ImageJob>({ queuedAt: 1000 });
function markup(attempts: ImageAttempt[], now = 10000) {
  return renderToStaticMarkup(
    <ImageAttemptHistory
      job={job}
      now={now}
      task={{ ordinal: 0, index: 0, style: "anime", state: "failed", attempts }}
    />,
  );
}

test("each attempt shows absolute timezone-labelled clocks, processing time, safe cause metadata and retry kind", () => {
  const html = markup(
    [
      {
        queuedAt: 1000,
        startedAt: 2000,
        finishedAt: 9000,
        requestId: "failed-id",
        kind: "generation",
        state: "failed",
        stage: "generating",
        failure,
      },
      {
        queuedAt: 10000,
        startedAt: 11000,
        requestId: "resumed-id",
        kind: "resume",
        state: "running",
        stage: "saving",
      },
      {
        queuedAt: 10000,
        requestId: "waiting-id",
        kind: "generation",
        state: "queued",
        stage: "waiting",
      },
      {
        queuedAt: 10000,
        startedAt: 11000,
        finishedAt: 12000,
        requestId: "done-id",
        kind: "resume",
        state: "completed",
        stage: "saving",
      },
    ],
    13000,
  );
  expect(html).toContain("대기 1초");
  expect(html).toContain("7초");
  expect(html).toContain('dateTime="1970-01-01T00:00:09.000Z"');
  expect(html).toContain("KST");
  expect(html).toContain("공급자 HTTP 422");
  expect(html).toContain("input_failed");
  expect(html).toContain("기존 접수 결과 조회·저장");
  expect(html).toContain("실행하지 않음");
});

test("an interrupted attempt does not keep increasing elapsed time or pretend recovery is failure time", () => {
  const attempt: ImageAttempt = {
    queuedAt: 1000,
    startedAt: 2000,
    recoveredAt: 8000,
    requestId: "interrupted-id",
    kind: "generation",
    state: "interrupted",
    stage: "saving",
    failure: { summary: "결과 불확실", stage: "saving", causeName: "Interruption" },
  };
  expect(markup([attempt], 10000)).toBe(markup([attempt], 90000));
  expect(markup([attempt])).toContain("실제 중단 시각은 알 수 없음");
  expect(markup([attempt])).not.toContain("처리 시간");
});

test("old records show only known clocks and explicitly identify missing diagnostics", () => {
  const row: ImageJob["tasks"][number] = {
    ordinal: 0,
    index: 0,
    style: "anime",
    state: "completed",
    startedAt: 1000,
    durationMs: 3000,
  };
  const html = renderToStaticMarkup(<ImageAttemptHistory task={row} job={job} now={90000} />);
  expect(html).toContain('dateTime="1970-01-01T00:00:04.000Z"');
  expect(html).toContain("상세 진단 수집 전 기록");
  const diagnosed = renderToStaticMarkup(
    <ImageAttemptHistory
      task={{ ...row, state: "failed", attempts: [] }}
      job={{ ...job, diagnostic: failure }}
      now={90000}
    />,
  );
  expect(diagnosed).toContain("공급자 요청 실패");
  const waiting = renderToStaticMarkup(
    <ImageAttemptHistory
      task={{ ordinal: 0, index: 0, style: "anime", state: "waiting" }}
      job={job}
      now={90000}
    />,
  );
  expect(waiting).not.toContain("실행 시작");
});
