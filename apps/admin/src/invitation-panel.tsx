import type { InvitationAccount, InvitationGrant, InvitationCreate } from "@ren-ai/onboarding";
import { InvitationRuleFields, invitationAvailable } from "./invitation-codes.tsx";

export interface InvitationView {
  requestId: string;
  handle: string;
  locale: typeof InvitationGrant.Type.locale;
  kind: typeof InvitationGrant.Type.kind;
  attempted: boolean;
  queued?: boolean;
  account?: typeof InvitationAccount.Type;
  creation?: typeof InvitationCreate.Type & { attempted: boolean };
  maxUses?: number;
  grantCount?: number;
}
const states = {
  queued: "발송 대기",
  sent: "발송 완료",
  failed: "발송 실패",
  uncertain: "발송 결과 불확실",
  skipped: "한도 초과·발송 생략",
};

export function InvitationPanel({ view }: { view: InvitationView | undefined }) {
  if (!view) return null;
  const basicGranted = view.account?.basicGranted ?? false;
  return (
    <section aria-label="전화번호로 초대장 지급">
      <h2>전화번호로 초대장 지급</h2>
      <p className="hint">
        자동 지급이 OFF여도 수동 지급할 수 있습니다. 미등록 번호도 가능하며, 받은 링크는 본인이
        사용하거나 친구에게 전달할 수 있습니다.
      </p>
      <form action="/waitlist" method="post" className="contact-selection">
        <label htmlFor="invitation-handle">초대장을 받을 전화번호</label>
        <input
          id="invitation-handle"
          type="tel"
          name="handle"
          defaultValue={view.handle}
          placeholder="010-1234-5678 또는 +1…"
          required
        />
        <button type="submit" name="action" value="invitation-lookup">
          초대장 조회
        </button>
      </form>
      {view.queued && (
        <output>
          초대장 지급을 저장하고 iMessage 발송을 예약했습니다. 아래에서 발송 상태를 확인해 주세요.
        </output>
      )}
      {(view.account || view.attempted) && (
        <>
          <h3>{view.handle}</h3>
          {view.account && (
            <p>
              기본 지급: {view.account.basicGranted ? "지급 완료" : "미지급"} · 추가 지급:{" "}
              {view.account.extraCount}장
            </p>
          )}
          <form action="/waitlist" method="post" className="contact-selection">
            <input type="hidden" name="action" value="invitation-grant" />
            <input type="hidden" name="requestId" value={view.requestId} />
            <input type="hidden" name="handle" value={view.handle} />
            <InvitationRuleFields
              maxUses={view.maxUses ?? 1}
              grantCount={view.grantCount ?? 2}
              locked={view.attempted}
            />
            {view.attempted ? (
              <>
                <input type="hidden" name="locale" value={view.locale} />
                <span>안내 언어: {view.locale}</span>
              </>
            ) : (
              <label htmlFor="invitation-locale">
                안내 언어
                <select id="invitation-locale" name="locale" defaultValue={view.locale}>
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
            )}
            {view.attempted ? (
              <>
                <input type="hidden" name="kind" value={view.kind} />
                <button type="submit">같은 지급 요청 확인</button>
              </>
            ) : (
              <>
                <button type="submit" name="kind" value="basic" disabled={basicGranted}>
                  기본 2장 지급
                </button>
                <button type="submit" name="kind" value="extra" className="secondary">
                  1장 추가 지급
                </button>
              </>
            )}
          </form>
          <p className="hint">
            기본 지급은 자동·수동을 합쳐 번호당 한 번입니다. 추가 지급은 매번 1장입니다. 발송
            실패·불확실 상태여도 아래의 기존 링크를 사용할 수 있으며 다시 지급해 링크를 복구할
            필요는 없습니다.
          </p>
          <ul>
            {view.account?.invitations.map((ticket) => (
              <li key={ticket.token}>
                <span>
                  {ticket.kind === "basic" ? "기본" : "추가"} ·{" "}
                  {ticket.usedCount === undefined
                    ? ticket.redeemedAt === null
                      ? "미사용"
                      : "사용 완료"
                    : `${ticket.usedCount}/${ticket.maxUses}명 사용 · 선정자에게 ${ticket.grantCount}개 지급`}{" "}
                  · {states[ticket.state]} ·{" "}
                  {new Date(ticket.createdAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                </span>
                {invitationAvailable(ticket) && (
                  <a href={`https://renai.im/explore#invite=${ticket.token}`}>초대 링크</a>
                )}
              </li>
            ))}
          </ul>
          <p className="hint">최근 발급한 초대장 최대 50장을 표시합니다.</p>
        </>
      )}
    </section>
  );
}
