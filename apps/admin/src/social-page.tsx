import { renderToStaticMarkup } from "react-dom/server";
import type { PersonaRecord } from "@ren-ai/personas";
import type { SocialAccount, SocialSnapshot } from "@ren-ai/onboarding/social";
import { AdminLayout } from "./admin-layout.tsx";

export interface SocialView {
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

function AccountForm({ selected, personas, personaId }: SocialView) {
  return (
    <form action="/social" method="post" className="contact-panel">
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="id" value={selected?.id ?? ""} />
      <h2>{selected ? `@${selected.handle} 연결 설정` : "X 계정 연결"}</h2>
      <p className="hint">
        먼저 페르소나를 선택하고 저장한 뒤, Messages Mac에서 전용 Chrome Canary 창을 열어 X에
        로그인하세요.
      </p>
      <div className="social-fields">
        <label>
          X 계정명
          <input
            name="handle"
            required
            pattern="[A-Za-z0-9_]{1,15}"
            maxLength={15}
            defaultValue={selected?.handle}
            placeholder="@ 없이 입력"
          />
        </label>
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
          기존 초대 코드
          <input name="invitation" required maxLength={64} defaultValue={selected?.invitation} />
        </label>
        <label>
          시간대
          <input name="timeZone" required defaultValue={selected?.timeZone ?? "Asia/Seoul"} />
        </label>
      </div>
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
            ["dailyWrites", "일일 게시·댓글·DM 합계", 1, 100, 5],
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
          defaultChecked={selected?.enabled ?? false}
        />{" "}
        소셜 활동 허용 · 시간대 안에서 자동 실행
      </label>
      <p className="hint">
        페르소나 또는 계정명을 변경하면 진행 중 활동을 중단하고 새 연결의 세션을 사용합니다. 기존 X
        게시물과 DM은 해당 X 계정에 남습니다.
      </p>
      <button type="submit">계정 연결 저장</button>
    </form>
  );
}

export function socialPage(view: SocialView) {
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <AdminLayout active="social" title="소셜 활동 · RenAI">
        <main id="main" className="contact-page social-workspace">
          <header className="page-heading">
            <h1>소셜 활동</h1>
            <p>X 계정과 페르소나를 연결하고, 자율 탐색·대화·초대를 운영합니다.</p>
            <a href="/social">새로고침 · 새 계정 연결</a>
          </header>
          {view.error && <p role="alert">{view.error}</p>}
          <section aria-label="연결된 X 계정" className="contact-panel">
            <h2>계정과 페르소나</h2>
            {!view.snapshot?.accounts.length && (
              <p>연결된 계정이 없습니다. 아래에서 활동할 페르소나를 선택하세요.</p>
            )}
            {view.snapshot?.accounts.map(({ account, state, nextAt, turns, writes }) => (
              <article key={account.id}>
                <h3>
                  <a href={`/social?account=${encodeURIComponent(account.id)}`}>
                    @{account.handle}
                  </a>{" "}
                  →{" "}
                  <a href={`/personas/${account.personaId}`}>
                    {view.personas.find((persona) => persona.id === account.personaId)?.name ??
                      account.personaId}
                  </a>
                </h3>
                <p>
                  {states[state] ?? state} · 판단 {turns}/{account.dailyTurns} · 게시·댓글·DM{" "}
                  {writes}/{account.dailyWrites}
                </p>
                {nextAt !== null && (
                  <p className="hint">
                    다음 확인: {date(nextAt, account.timeZone)} ({account.timeZone})
                  </p>
                )}
                <form action="/social" method="post" className="contact-selection">
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
                    disabled={!account.enabled || state === "running"}
                  >
                    지금 실행
                  </button>
                </form>
              </article>
            ))}
          </section>
          <AccountForm {...view} />
          <section className="contact-panel" aria-label="소셜 활동 내역">
            <h2>활동 내역</h2>
            {!view.snapshot?.events.length && <p>아직 활동 내역이 없습니다.</p>}
            {view.snapshot?.events.map((event) => (
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
                    X에서 결과 보기
                  </a>
                )}
              </article>
            ))}
            {view.snapshot?.before != null && (
              <a href={`/social?before=${view.snapshot.before}`}>이전 활동</a>
            )}
          </section>
        </main>
      </AdminLayout>,
    )
  );
}
