import { renderToStaticMarkup } from "react-dom/server";
import type { PersonaRecord } from "@ren-ai/personas";
import {
  socialPlatformName,
  type SocialPlatform,
  type SocialAccount,
  type SocialSnapshot,
} from "@ren-ai/onboarding/social";
import { AdminLayout } from "./admin-layout.tsx";
import { SocialAuthentication } from "./social-auth.tsx";
import type { SocialAuthStatus } from "@ren-ai/onboarding/social-auth";
import { SocialDeployment } from "./social-deployment.tsx";

export interface SocialView {
  platform?: SocialPlatform;
  authentication?: SocialAuthStatus;
  snapshot?: SocialSnapshot;
  personas: readonly PersonaRecord[];
  selected?: SocialAccount;
  personaId?: string;
  error?: string;
}
const states: Record<string, string> = {
  changing: "연결 변경 중",
  paused: "중지됨",
  scheduled: "예약됨",
  running: "활동 중",
  completed: "완료",
  failed: "실패",
  interrupted: "중단됨",
  login_required: "Mac에서 로그인 필요",
  pending: "처리 중",
  uncertain: "결과 미확인",
};
const kinds: Record<string, string> = {
  search: "사용자 탐색",
  profile: "프로필 확인",
  notifications: "알림 확인",
  inbox: "DM 목록 확인",
  messages: "DM 읽기",
  post: "게시",
  reply: "댓글",
  dm: "DM 보내기",
  contact: "대화 상대 전환",
  finish: "활동 마침",
};
const date = (at: number, timeZone = "Asia/Seoul") =>
  new Date(at).toLocaleString("ko-KR", { timeZone });
const platformFields = {
  threads: {
    loginLabel: "Instagram 로그인 ID",
    loginPlaceholder: "Instagram 사용자명·이메일·전화번호",
    writesLabel: "일일 게시·댓글 합계",
  },
  x: {
    loginLabel: "로그인 ID",
    loginPlaceholder: "이메일·전화번호·사용자명",
    writesLabel: "일일 게시·댓글·DM 합계",
  },
};

function AccountName({ account }: { account: SocialAccount | undefined }) {
  return (
    <p>
      계정명: <output>{account?.handle ? `@${account.handle}` : "로그인 후 자동 확인"}</output>
    </p>
  );
}

function AccountForm({
  selected,
  personas,
  personaId,
  authentication,
  platform,
}: SocialView & { platform: SocialPlatform }) {
  const fields = platformFields[platform];
  return (
    <form
      action={
        selected
          ? `/social?platform=${platform}&account=${encodeURIComponent(selected.id)}`
          : `/social?platform=${platform}&new=1`
      }
      method="post"
      className="contact-panel"
      autoComplete="off"
    >
      <input type="hidden" name="id" value={selected?.id ?? ""} />
      <input type="hidden" name="platform" value={platform} />
      <h2>
        {selected?.handle
          ? `@${selected.handle} 연결 설정`
          : `${socialPlatformName(platform)} 계정 연결`}
      </h2>
      <p className="hint">
        페르소나와 로그인 정보를 함께 입력하세요. ID·비밀번호를 Mac에 먼저 저장하고 로그인을
        시도합니다.
      </p>
      <fieldset disabled={["logging_in", "checking"].includes(authentication?.state ?? "")}>
        <div className="social-fields">
          <AccountName account={selected} />
          <label>
            연결할 페르소나
            <select name="personaId" required defaultValue={selected?.personaId ?? personaId ?? ""}>
              <option value="" disabled>
                페르소나 선택
              </option>
              {personas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.name} · {persona.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            가입 초대 코드
            <input name="invitation" required maxLength={64} defaultValue={selected?.invitation} />
          </label>
          <label>
            시간대
            <input name="timeZone" required defaultValue={selected?.timeZone ?? "Asia/Seoul"} />
          </label>
        </div>
        <div className="social-fields">
          <label>
            {fields.loginLabel}
            <input
              name="username"
              maxLength={320}
              autoComplete="off"
              placeholder={fields.loginPlaceholder}
            />
          </label>
          <label>
            비밀번호
            <input type="password" name="password" maxLength={4096} autoComplete="new-password" />
          </label>
        </div>
        <p className="hint">
          이미 로그인했다면 ID·비밀번호 없이 로그인 상태를 확인할 수 있습니다. 로그인을 시도하려면
          두 항목을 모두 입력하세요. 로그인 정보는 Messages Mac에만 암호화해 보관합니다. 로그인에
          실패해도 저장된 정보로 재시도할 수 있습니다. 저장된 비밀번호는 표시하지 않습니다.
          {selected &&
            " 로그인 정보를 변경하려면 두 항목을 모두 입력하세요. 비워두면 기존 정보를 유지하고 설정만 저장합니다."}
        </p>
        {platform === "threads" && (
          <p className="hint">
            Threads는 공개 글 탐색·게시·댓글을 지원하며 DM·알림은 지원하지 않습니다.
          </p>
        )}
        <label>
          활동 지침
          <textarea
            name="instructions"
            maxLength={6000}
            rows={4}
            defaultValue={
              selected?.instructions ??
              "Character.AI·제타 등 AI 컴패니언을 실제로 사용하는 사람을 찾아 관심사와 사용 경험을 알아보세요. 자신의 취향과 맞는 글에 대화하고, 관심이 이어지면 RenAI 초대를 제안하세요."
            }
          />
        </label>
        <div className="social-fields social-limits">
          {(
            [
              ["startHour", "활동 시작 시 (0–23)", 0, 23, 9],
              ["endHour", "활동 종료 시 (1–24)", 1, 24, 22],
              ["intervalMinutes", "실행 간격 (분)", 15, 1440, 30],
              ["runMinutes", "한 번의 활동 시간 (분)", 1, 30, 5],
              ["dailyTurns", "일일 모델 판단 횟수", 1, 200, 20],
              ["dailyWrites", fields.writesLabel, 1, 100, 5],
            ] as const
          ).map(([name, label, min, max, initial]) => (
            <label key={name}>
              {label}
              <input
                type="number"
                name={name}
                min={min}
                max={max}
                required
                defaultValue={selected?.[name] ?? initial}
              />
            </label>
          ))}
        </div>
        <label>
          <input
            type="checkbox"
            name="enabled"
            value="1"
            defaultChecked={Boolean(selected?.enabled)}
          />{" "}
          소셜 활동 허용 · 시간대 안에서 자동 실행
        </label>
        <p className="hint">
          계정명은 로그인 후 자동으로 확인합니다. 페르소나를 변경하면 진행 중 활동을 중단하고 새
          연결의 세션을 사용합니다. 기존 게시물과 DM은 해당 플랫폼 계정에 남습니다.
        </p>
        {!selected && (
          <button type="submit" name="action" value="save-check">
            연결하고 로그인 상태 확인
          </button>
        )}
        <button type="submit" name="action" value="save" className="secondary">
          {selected ? "설정 저장 · 입력한 정보로 로그인" : "연결하고 로그인"}
        </button>
      </fieldset>
    </form>
  );
}

export function socialPage(view: SocialView) {
  const platform = view.platform ?? view.selected?.platform ?? "threads";
  const base = `/social?platform=${platform}`;
  const accounts = view.snapshot?.accounts.filter((row) => row.account.platform === platform) ?? [];
  const accountIds = new Set(accounts.map((row) => row.account.id));
  const events = view.snapshot?.events.filter((event) => accountIds.has(event.accountId)) ?? [];
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <AdminLayout active="social" title="소셜 활동 · RenAI">
        <main id="main" className="contact-page social-workspace">
          <header className="page-heading">
            <h1>소셜 활동</h1>
            <p>Threads·X 계정과 페르소나를 연결하고, 자율 탐색·대화·초대를 운영합니다.</p>
            <a
              href={
                view.selected ? `${base}&account=${encodeURIComponent(view.selected.id)}` : base
              }
            >
              새로고침
            </a>
            <a href={`${base}&new=1`}>새 계정 연결</a>
          </header>
          <nav className="contact-tabs social-platform-tabs" aria-label="소셜 플랫폼">
            {(["threads", "x"] as const).map((value) => (
              <a
                key={value}
                href={`/social?platform=${value}${view.personaId ? `&persona=${encodeURIComponent(view.personaId)}` : ""}`}
                aria-current={platform === value ? "page" : undefined}
              >
                {socialPlatformName(value)}
              </a>
            ))}
          </nav>
          {view.error && <p role="alert">{view.error}</p>}
          <SocialDeployment
            status={view.snapshot?.deployment}
            platform={platform}
            accountId={view.selected?.id}
          />
          <section aria-label="연결된 소셜 계정" className="contact-panel">
            <h2>계정과 페르소나</h2>
            {!view.snapshot && (
              <p>
                <output>계정 목록을 불러오지 못했습니다. 새로고침해 주세요.</output>
              </p>
            )}
            {view.snapshot && !accounts.length && (
              <p>연결된 계정이 없습니다. 아래에서 활동할 페르소나를 선택하세요.</p>
            )}
            {accounts.map(({ account, state, nextAt, turns, writes }) => (
              <article key={account.id}>
                <h3>
                  <a href={`${base}&account=${encodeURIComponent(account.id)}`}>
                    {socialPlatformName(account.platform)} ·{" "}
                    {account.handle ? `@${account.handle}` : "계정 확인 대기"}
                  </a>{" "}
                  →{" "}
                  <a href={`/personas/${account.personaId}`}>
                    {view.personas.find((persona) => persona.id === account.personaId)?.name ??
                      account.personaId}
                  </a>
                </h3>
                <p>
                  {states[state] ?? state} · 판단 {turns}/{account.dailyTurns} ·{" "}
                  {platform === "threads" ? "게시·댓글" : "게시·댓글·DM"} {writes}/
                  {account.dailyWrites}
                </p>
                {nextAt !== null && (
                  <p className="hint">
                    다음 확인: {date(nextAt, account.timeZone)} ({account.timeZone})
                  </p>
                )}
                <form
                  action={`${base}&account=${encodeURIComponent(account.id)}`}
                  method="post"
                  className="contact-selection"
                >
                  <input type="hidden" name="id" value={account.id} />
                  <button name="action" value="open" className="secondary">
                    Mac에서 Canary 열기
                  </button>
                  <button name="action" value="toggle" className="secondary">
                    {account.enabled ? "활동 중지" : "활동 시작"}
                  </button>
                  <button
                    name="action"
                    value="now"
                    disabled={
                      !account.enabled ||
                      !account.handle ||
                      ["running", "login_required"].includes(state)
                    }
                  >
                    지금 실행
                  </button>
                </form>
              </article>
            ))}
          </section>
          <AccountForm {...view} platform={platform} />
          {view.selected && (
            <SocialAuthentication
              accountId={view.selected.id}
              platform={view.selected.platform}
              status={view.authentication}
            />
          )}
          <section className="contact-panel" aria-label="소셜 활동 내역">
            <h2>활동 내역</h2>
            {!view.snapshot && (
              <p>
                <output>활동 내역을 불러오지 못했습니다.</output>
              </p>
            )}
            {view.snapshot && !events.length && <p>이 페이지에 표시할 활동 내역이 없습니다.</p>}
            {events.map((event) => (
              <article key={event.id}>
                <h3>
                  {kinds[event.kind] ?? event.kind} · {states[event.state]}
                </h3>
                <p className="hint">
                  {date(event.at)} · {event.accountId} → {event.personaId}
                </p>
                <p>{event.reason}</p>
                <pre className="conversation-text">{event.text}</pre>
                {event.url && (
                  <a href={event.url} target="_blank" rel="noreferrer">
                    게시물 보기
                  </a>
                )}
              </article>
            ))}
            {view.snapshot?.before != null && (
              <a href={`${base}&before=${view.snapshot.before}`}>이전 활동</a>
            )}
          </section>
        </main>
      </AdminLayout>,
    )
  );
}
