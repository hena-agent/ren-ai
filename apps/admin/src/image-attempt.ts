import { PersonaError } from "@ren-ai/personas";
import { failureStage, GenerationError, safeText } from "./logging.ts";

export interface ImageFailure {
  summary: string;
  stage: string;
  code?: string;
  status?: number;
  causeName: string;
  causeCode?: string;
}
export interface ImageAttempt {
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  recoveredAt?: number;
  requestId: string;
  kind: "generation" | "resume";
  state: "queued" | "running" | "completed" | "failed" | "blocked" | "interrupted";
  stage: string;
  failure?: ImageFailure;
}
interface AttemptTask {
  startedAt?: number;
  durationMs?: number;
  requestId?: string;
  attempts?: ImageAttempt[];
}

const reasons: Readonly<Record<string, string>> = {
  timeout: "요청 시간이 초과됐습니다. 공급자의 최종 처리 여부는 아직 확인되지 않았습니다.",
  http_error: "공급자가 요청 또는 결과 조회를 오류 응답으로 거절했습니다.",
  upstream_error: "공급자가 이미지 생성 요청을 처리하지 못했습니다.",
  network_error: "공급자와 통신하지 못했습니다. 접수된 작업의 최종 결과를 확인해야 합니다.",
  invalid_response: "공급자 응답의 JSON·필수 필드·레이어 순서 등 형식 검증에 실패했습니다.",
  invalid_layer_bounds: "공급자가 반환한 레이어 위치·크기가 올바르지 않습니다.",
  invalid_layer_dimensions: "공급자가 반환한 레이어 해상도가 지원 범위를 벗어났습니다.",
  image_http_error: "생성된 PNG를 다운로드하지 못했습니다.",
  missing_key: "선택한 공급자의 API 키가 설정되지 않았습니다.",
  reference_unavailable: "생성에 필요한 원본 이미지를 읽지 못했습니다.",
  layer_result_pending:
    "공급자 작업이 대기 제한 안에 끝나지 않았습니다. 같은 접수 결과를 이어서 조회할 수 있습니다.",
};

export function imageFailure(error: Error, stage: string): ImageFailure {
  const fields = error instanceof GenerationError ? error.fields : {};
  const root = error.cause instanceof Error ? error.cause : error;
  const rootCode = "code" in root && typeof root.code === "string" ? root.code : undefined;
  const code = fields.code ?? (error instanceof PersonaError ? error.kind : rootCode);
  const causeCode = fields.causeCode ?? rootCode;
  return {
    summary:
      error instanceof PersonaError
        ? safeText(error.message).slice(0, 500)
        : (reasons[code ?? ""] ??
          (error instanceof GenerationError
            ? safeText(error.message).slice(0, 500)
            : "예상하지 못한 처리 오류입니다. 요청 ID로 서버 진단을 확인하세요.")),
    stage: failureStage(error) ?? stage,
    ...(code && { code: safeText(code).slice(0, 80) }),
    ...(fields.status !== undefined && { status: fields.status }),
    causeName: safeText(fields.causeName ?? root.name).slice(0, 80),
    ...(causeCode && { causeCode: safeText(causeCode).slice(0, 80) }),
  };
}

export function queueAttempt(
  task: AttemptTask,
  queuedAt: number,
  requestId: string,
  resume: boolean,
) {
  (task.attempts ??= []).push({
    queuedAt,
    requestId,
    kind: resume ? "resume" : "generation",
    state: "queued",
    stage: "image.queue.waiting",
  });
}

export function beginAttempt(
  task: AttemptTask,
  queuedAt: number,
  requestId: string,
  resume: boolean,
) {
  if (!task.attempts?.length) queueAttempt(task, queuedAt, requestId, resume);
  const attempt = task.attempts!.at(-1)!;
  if (attempt.startedAt !== undefined) return;
  attempt.startedAt = Date.now();
  attempt.state = "running";
  attempt.stage = "image.queue.prepare";
  task.startedAt = attempt.startedAt;
  task.requestId = requestId;
}

export function finishAttempt(
  task: AttemptTask,
  state: "completed" | "failed" | "blocked",
  failure?: ImageFailure,
) {
  const attempt = task.attempts?.at(-1);
  if (!attempt || (attempt.state !== "queued" && attempt.state !== "running")) return;
  attempt.state = state;
  attempt.finishedAt = Date.now();
  if (attempt.startedAt !== undefined) task.durationMs = attempt.finishedAt - attempt.startedAt;
  if (failure) attempt.failure = failure;
}

export function interruptAttempt(task: AttemptTask) {
  const attempt = task.attempts?.at(-1);
  if (!attempt) return;
  attempt.state = "interrupted";
  attempt.recoveredAt = Date.now();
  attempt.failure = {
    summary:
      "실행 중 프로세스가 중단됐습니다. 공급자 처리 여부가 불확실하며 자동으로 다시 생성하지 않습니다.",
    stage: attempt.stage,
    code: "interrupted",
    causeName: "Interruption",
  };
}
