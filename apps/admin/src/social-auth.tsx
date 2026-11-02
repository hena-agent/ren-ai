import type { SocialAuthStatus } from "@ren-ai/onboarding/social-auth";
import { socialPlatformName, type SocialPlatform } from "@ren-ai/onboarding/social";

const labels: Record<SocialAuthStatus["state"], string> = {
  not_configured: "로그인 정보 없음",
  login_required: "로그인 필요",
  logging_in: "로그인 진행 중",
  checking: "로그인 상태 확인 중",
  authenticated: "로그인됨",
  code_required: "인증코드 입력 필요",
  manual_required: "Mac에서 추가 인증 필요",
  failed: "로그인 실패",
};
export function SocialAuthentication({
  accountId,
  platform,
  status,
}: {
  accountId: string;
  platform: SocialPlatform;
  status: SocialAuthStatus | undefined;
}) {
  const busy = status?.state === "logging_in" || status?.state === "checking";
  const name = socialPlatformName(platform);
  return (
    <section className="contact-panel" aria-label={`${name} 로그인 관리`}>
      <h2>{name} 로그인 · 자동 재로그인</h2>
      <output>
        {status?.reason === "check_unavailable"
          ? "로그인 상태 확인 실패"
          : status
            ? labels[status.state]
            : "로그인 상태를 확인할 수 없습니다."}
      </output>
      {status && (
        <p>
          {status.hasCredentials
            ? "ID·비밀번호 저장됨 — 로그인 실패 시 재입력 없이 재시도할 수 있습니다."
            : "저장된 로그인 정보가 없습니다."}
        </p>
      )}
      <p className="hint">
        로그인 정보는 Messages Mac의 암호화된 vault에만 보관합니다. 저장된 비밀번호는 표시하지
        않으며, 로그인 세션이 만료되면 자동으로 다시 로그인합니다.
      </p>
      {status?.reason === "account_mismatch" && (
        <p role="alert">
          Canary에 로그인된 계정이 연결한 {name} 계정명과 다릅니다. Mac에서 계정을 확인해 주세요.
        </p>
      )}
      {status?.reason === "credentials_rejected" && (
        <p role="alert">
          {name}가 로그인 정보를 거절했습니다. ID·비밀번호 또는 인증코드를 확인해 주세요.
        </p>
      )}
      {status?.state === "manual_required" && (
        <p role="alert">
          CAPTCHA 등 직접 조작이 필요한 화면입니다. Mac에서 Canary를 열어 처리한 뒤 로그인 확인을
          눌러 주세요.
        </p>
      )}
      {status?.state === "code_required" && (
        <form action={`/social?platform=${platform}`} method="post">
          <input type="hidden" name="action" value="auth-code" />
          <input type="hidden" name="id" value={accountId} />
          <label>
            인증코드
            <input name="code" required minLength={4} maxLength={64} autoComplete="one-time-code" />
          </label>
          <button type="submit">인증코드 제출</button>
        </form>
      )}
      <form action={`/social?platform=${platform}`} method="post" className="contact-selection">
        <input type="hidden" name="id" value={accountId} />
        <button name="action" value="auth-check" className="secondary" disabled={busy}>
          로그인 상태 확인
        </button>
        <button
          name="action"
          value="auth-login"
          className="secondary"
          disabled={busy || !status?.hasCredentials}
        >
          저장된 정보로 로그인 재시도
        </button>
        <button
          name="action"
          value="auth-forget"
          className="secondary"
          disabled={busy || !status?.hasCredentials}
        >
          자동로그인 정보 삭제·활동 중지
        </button>
      </form>
      <p className="hint">
        로그인 상태 확인은 현재 브라우저의 계정만 확인하며 ID·비밀번호를 입력하지 않습니다. 이미
        로그인돼 있으면 기존 세션을 그대로 사용합니다.
      </p>
      <a href={`/social?platform=${platform}&account=${encodeURIComponent(accountId)}`}>
        로그인 상태 새로고침
      </a>
    </section>
  );
}
