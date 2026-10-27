import type { InvitationTicket } from "@ren-ai/onboarding";
import type { InvitationView } from "./invitation-panel.tsx";

export const invitationAvailable = (
  ticket: Pick<typeof InvitationTicket.Type, "redeemedAt" | "usedCount" | "maxUses">,
) =>
  ticket.usedCount === undefined ? ticket.redeemedAt === null : ticket.usedCount < ticket.maxUses!;

export function InvitationRuleFields({
  maxUses,
  grantCount,
  locked = false,
}: {
  maxUses: number;
  grantCount: number;
  locked?: boolean;
}) {
  return (
    <>
      <label>
        최대 사용 인원
        <input
          type="number"
          name="maxUses"
          min="1"
          max="10000"
          required
          defaultValue={maxUses}
          readOnly={locked}
        />
      </label>
      <label>
        초대장 지급 수
        <input
          type="number"
          name="grantCount"
          min="0"
          max="100"
          required
          defaultValue={grantCount}
          readOnly={locked}
        />
      </label>
    </>
  );
}

export function InvitationCodes({
  view,
  codes,
}: {
  view: InvitationView | undefined;
  codes: readonly (typeof InvitationTicket.Type)[] | undefined;
}) {
  const creation = view?.creation;
  if (!creation) return null;
  return (
    <section aria-label="연락처 없이 초대 코드 만들기">
      <h2>연락처 없이 초대 코드 만들기</h2>
      <p className="hint">
        공통 모집 코드는 THREAD20처럼 직접 정하고, 개별 코드는 비워 두면 자동 생성됩니다. 링크와
        코드를 복사해 Threads·DM·이메일로 공유하세요.
      </p>
      <p className="hint">
        선정자에게 지급한 새 코드도 최대 사용 인원과 초대장 지급 수를 그대로 상속합니다. 인원 한도는
        코드마다 따로 적용됩니다. 지급 수가 0이면 다음 초대장을 지급하지 않습니다.
      </p>
      <form action="/waitlist" method="post" className="contact-selection">
        <input type="hidden" name="action" value="invitation-create" />
        <input type="hidden" name="requestId" value={creation.requestId} />
        <label>
          초대 코드 (선택)
          <input
            name="code"
            maxLength={64}
            pattern="[A-Za-z0-9_\-]+"
            placeholder="THREAD20 또는 자동 생성"
            defaultValue={creation.code ?? ""}
            readOnly={creation.attempted}
          />
        </label>
        <InvitationRuleFields
          maxUses={creation.maxUses}
          grantCount={creation.grantCount}
          locked={creation.attempted}
        />
        <button type="submit">
          {creation.attempted ? "같은 코드 생성 요청 확인" : "초대 코드 만들기"}
        </button>
      </form>
      <h3>최근 생성한 코드 (최대 50개)</h3>
      <ul>
        {codes?.map((code) => (
          <li key={code.token}>
            <code>{code.token}</code> · {code.usedCount}/{code.maxUses}명 사용 · 선정자에게{" "}
            {code.grantCount}개 지급
            <label>
              공유 링크
              <input
                aria-label={`${code.token} 공유 링크`}
                readOnly
                value={`https://renai.im/explore#invite=${code.token}`}
              />
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
