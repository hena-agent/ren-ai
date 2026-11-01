import type { SocialAuthStatus } from "@ren-ai/onboarding/social-auth";

const labels: Record<SocialAuthStatus["state"], string> = {
  not_configured: "로그인 정보 없음",
  login_required: "로그인 필요",
  logging_in: "로그인 진행 중",
  authenticated: "로그인됨",
  code_required: "인증코드 입력 필요",
  manual_required: "Mac에서 추가 인증 필요",
  failed: "로그인 실패",
};
export function SocialAuthentication({
  accountId,
  status,
}: {
  accountId: string;
  status: SocialAuthStatus | undefined;
}) {
  const busy = status?.state === "logging_in";
  return (
    <section className="contact-panel" aria-label="X 로그인 관리">
      <h2>X 로그인 · 자동 재로그인</h2>
      <output>{status ? labels[status.state] : "로그인 상태를 확인할 수 없습니다."}</output>
      <p className="hint">
        로그인 정보는 Messages Mac의 암호화된 vault에만 보관합니다. 저장된 비밀번호는 표시하지
        않으며, 로그인 세션이 만료되면 자동으로 다시 로그인합니다.
      </p>
      {status?.reason === "account_mismatch" && (
        <p role="alert">
          Canary에 로그인된 X 계정이 연결한 계정명과 다릅니다. Mac에서 계정을 확인해 주세요.
        </p>
      )}
      {status?.reason === "credentials_rejected" && (
        <p role="alert">
          X가 로그인 정보를 거절했습니다. ID·비밀번호 또는 인증코드를 확인해 주세요.
        </p>
      )}
      {status?.state === "manual_required" && (
        <p role="alert">
          CAPTCHA 등 직접 조작이 필요한 화면입니다. Mac에서 Canary를 열어 처리한 뒤 로그인 확인을
          눌러 주세요.
        </p>
      )}
      {status?.state === "code_required" && (
        <form action="/social" method="post">
          <input type="hidden" name="action" value="auth-code" />
          <input type="hidden" name="id" value={accountId} />
          <label>
            인증코드
            <input name="code" required minLength={4} maxLength={64} autoComplete="one-time-code" />
          </label>
          <button type="submit">인증코드 제출</button>
        </form>
      )}
      <form action="/social" method="post" className="contact-selection">
        <input type="hidden" name="id" value={accountId} />
        <button name="action" value="auth-login" className="secondary" disabled={busy}>
          로그인 확인·재시도
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
      <a href={`/social?account=${encodeURIComponent(accountId)}`}>로그인 상태 새로고침</a>
    </section>
  );
}
