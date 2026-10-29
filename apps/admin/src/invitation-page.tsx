import { InvitationPanel } from "./invitation-panel.tsx";
import { InvitationCodes } from "./invitation-codes.tsx";
import type { ContactView } from "./contact-page.tsx";

export function InvitationPage({ view }: { view: ContactView }) {
  const settings = view.snapshot?.invitationSettings;
  const section = new URL(view.action, "https://admin.test").searchParams.get("section");
  const tab = section === "phone" || section === "settings" ? section : "codes";
  return (
    <section className="invitation-management" aria-label="초대장 관리">
      <nav className="contact-tabs" aria-label="초대장 작업">
        {(
          [
            ["codes", "초대 코드"],
            ["phone", "전화번호 지급"],
            ["settings", "자동 지급 설정"],
          ] as const
        ).map(([key, label]) => (
          <a
            key={key}
            href={`/invitations?section=${key}`}
            aria-current={tab === key ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="contact-panel">
        {tab === "codes" && (
          <InvitationCodes view={view.invitation} codes={view.snapshot?.invitationCodes} />
        )}
        {tab === "phone" && <InvitationPanel view={view.invitation} />}
        {tab === "settings" &&
          (settings ? (
            <section aria-label="초대장 지급 설정">
              <div className="queue-heading">
                <h2>초대장 자동 지급</h2>
                <span className="contact-status">{settings.enabled ? "ON" : "OFF"}</span>
              </div>
              <p className="hint">
                켜면 이후 최초 선정되는 유저에게 초대 코드의 지급 수만큼 새 코드를 지급하고 두
                설정을 상속합니다. 코드 없는 선정은 기본 2장입니다. 이전 선정자에게 소급 지급하지
                않습니다.
              </p>
              <p className="hint">꺼도 기존 코드는 사용할 수 있으며 수동 발급도 가능합니다.</p>
              <form
                action="/invitations?section=settings"
                method="post"
                className="contact-selection"
              >
                <input type="hidden" name="action" value="invitations" />
                <input type="hidden" name="enabled" value={String(!settings.enabled)} />
                <button type="submit" className="secondary">
                  초대장 지급 {settings.enabled ? "끄기" : "켜기"}
                </button>
              </form>
            </section>
          ) : (
            <output>자동 지급 설정을 확인할 수 없습니다. API 연결 상태를 확인해 주세요.</output>
          ))}
      </div>
    </section>
  );
}
