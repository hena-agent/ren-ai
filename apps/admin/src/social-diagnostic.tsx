import type { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";

export function SocialFailureDetails({ diagnostic }: { diagnostic: SocialDiagnostic | undefined }) {
  if (!diagnostic) return null;
  return (
    <details>
      <summary>
        진단 · {diagnostic.stage} · {diagnostic.code}
      </summary>
      <dl>
        <dt>요청 ID</dt>
        <dd>{diagnostic.requestId}</dd>
        {diagnostic.postId && (
          <>
            <dt>관측된 게시물 ID</dt>
            <dd>{diagnostic.postId}</dd>
          </>
        )}
        {diagnostic.upstreamRequestId && (
          <>
            <dt>상위 요청 ID</dt>
            <dd>{diagnostic.upstreamRequestId}</dd>
          </>
        )}
        {diagnostic.revision && (
          <>
            <dt>실행 버전</dt>
            <dd>{diagnostic.revision}</dd>
          </>
        )}
        <dt>실패 단계</dt>
        <dd>{diagnostic.stage}</dd>
        <dt>전송 상태</dt>
        <dd>
          {diagnostic.submission === "not_attempted"
            ? "전송 시도 전"
            : diagnostic.submission === "attempted"
              ? "전송 시도 후 · 결과 확인 필요"
              : "게시 확인됨"}
        </dd>
        <dt>기록 시각</dt>
        <dd>{new Date(diagnostic.at).toISOString()}</dd>
        <dt>소요 시간</dt>
        <dd>{diagnostic.durationMs}ms</dd>
        {diagnostic.causeCode && (
          <>
            <dt>원인 코드</dt>
            <dd>{diagnostic.causeCode}</dd>
          </>
        )}
        {diagnostic.upstreamStatus && (
          <>
            <dt>HTTP 상태</dt>
            <dd>{diagnostic.upstreamStatus}</dd>
          </>
        )}
      </dl>
      {diagnostic.stack && <pre>{diagnostic.stack}</pre>}
    </details>
  );
}
