import type { MacDeploymentStatus } from "@ren-ai/transport/deployment";
import type { SocialPlatform } from "@ren-ai/onboarding/social";

const phases: Record<MacDeploymentStatus["state"], string> = {
  waiting_agent: "Mac 배포 에이전트 연결 대기",
  queued: "Mac 작업 수신 대기",
  installing: "필수 프로그램·실행기 설치 중",
  starting: "Mac 서비스 기동 중",
  verifying: "설치 버전·실행 상태 확인 중",
  ready: "Mac 실행기 설치·상태 확인 완료",
  failed: "Mac 실행기 복구 실패",
};
export function SocialDeployment({
  status,
  platform,
  accountId,
}: {
  status: MacDeploymentStatus | undefined;
  platform: SocialPlatform;
  accountId: string | undefined;
}) {
  const pending =
    status && ["queued", "installing", "starting", "verifying"].includes(status.state);
  return (
    <section className="contact-panel" aria-label="Mac 실행기 관리">
      <h2>Mac 실행기 설치·복구</h2>
      <output>{status ? phases[status.state] : "Mac 배포 상태 조회 대기"}</output>
      <p className="hint">
        기존 연결·프로필·쿠키·로그인 정보를 유지하며 Mac에서 설치와 복구를 자동 실행합니다.
        에이전트가 연결돼 있으면 통상 1분 안에 작업을 수신합니다. 설치 완료와 계정 로그인 여부는
        별도로 확인합니다.
      </p>
      {status && (
        <p className="hint">
          단계: {status.stage} · 요청 버전: {status.revision}
          {status.gatewayRevision && ` · 게이트웨이: ${status.gatewayRevision}`}
          {status.socialRevision && ` · 소셜 실행기: ${status.socialRevision}`}
        </p>
      )}
      {status?.code && (
        <p role="alert">
          진단 코드: {status.code} · 작업 ID: {status.id}
        </p>
      )}
      <form
        method="post"
        action={`/social?platform=${platform}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`}
      >
        {accountId && <input type="hidden" name="id" value={accountId} />}
        <button name="action" value="repair-runtime" disabled={Boolean(pending)}>
          Mac 실행기 자동 설치·복구
        </button>
      </form>
      {pending && (
        <a
          href={`/social?platform=${platform}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`}
        >
          복구 상태 새로고침
        </a>
      )}
    </section>
  );
}
