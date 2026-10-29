import type {
  ContactSnapshot,
  ContactSelection,
  ConversationLanguages,
  SelectContacts,
} from "@ren-ai/onboarding";
import { LanguageReadout } from "./language-panel.tsx";
import type { InvitationView } from "./invitation-panel.tsx";
import { InvitationPage } from "./invitation-page.tsx";
import { ContactRows } from "./contact-rows.tsx";
import { ContactFilters } from "./contact-filters.tsx";
import { filterContacts, type ContactQuery } from "./contact-query.ts";

export interface ContactView {
  tab: "waitlist" | "first-contacts" | "invitations";
  query: ContactQuery;
  action: string;
  requestId: string;
  startRequestId: string;
  directRequestId: string;
  registrationIDs: readonly string[];
  assignments: NonNullable<typeof SelectContacts.Type.assignments>;
  directAttempted?: boolean;
  count: number;
  attempted?: boolean;
  snapshot?: typeof ContactSnapshot.Type;
  selection?: typeof ContactSelection.Type;
  languages?: typeof ConversationLanguages.Type;
  invitation?: InvitationView;
  notice?: string;
}
function BulkActions({ view }: { view: ContactView }) {
  return (
    <form
      id="contact-direct-selection"
      action={view.action}
      method="post"
      className="contact-selection"
      aria-label="대기자 직접 선정"
      data-contact-retry={String(Boolean(view.directAttempted))}
    >
      <input type="hidden" name="requestId" value={view.directRequestId} />
      {view.directAttempted &&
        view.registrationIDs.map((id) => (
          <input key={id} type="hidden" name="registrationIDs" value={id} />
        ))}
      {view.directAttempted &&
        view.assignments.map((a) => (
          <input
            key={a.registrationID}
            type="hidden"
            name={`personaID:${a.registrationID}`}
            value={a.personaID}
          />
        ))}
      <output data-contact-count aria-live="polite">
        {view.registrationIDs.length}명 선택
      </output>
      {view.tab === "waitlist" && (
        <button
          type="submit"
          name="action"
          value="select-specific"
          data-contact-needs-selection
          disabled={!view.directAttempted}
        >
          {view.directAttempted ? "같은 직접 선정 요청 확인" : "선택한 대기자 선정하기"}
        </button>
      )}
      <button
        type="submit"
        name="action"
        value={view.query.visibility === "hidden" ? "restore" : "hide"}
        className="secondary"
        data-contact-needs-selection
        disabled={!view.registrationIDs.length || view.directAttempted}
      >
        {view.query.visibility === "hidden" ? "선택 복원" : "선택 숨기기"}
      </button>
    </form>
  );
}
function RandomSelection({ view }: { view: ContactView }) {
  return (
    <details className="contact-random" open={view.attempted}>
      <summary>무작위 선정</summary>
      <p className="hint">필터와 관계없이 숨기지 않은 전체 선정 가능 대기자 중에서 뽑습니다.</p>
      <form
        action={view.action}
        method="post"
        className="contact-selection"
        aria-label="무작위 선정"
      >
        <input type="hidden" name="requestId" value={view.requestId} />
        <label htmlFor="contact-count">인원</label>
        <input
          id="contact-count"
          type="number"
          name="count"
          min="1"
          max="100"
          required
          defaultValue={view.count}
        />
        <span>명</span>
        <button type="submit" disabled={!view.attempted && !view.snapshot?.eligibleCount}>
          {view.attempted ? "같은 선정 요청 확인" : "무작위 선정 실행"}
        </button>
      </form>
    </details>
  );
}
function Summary({ view }: { view: ContactView }) {
  const total = view.snapshot?.entries.filter(
    (e) => view.tab === "waitlist" || e.state !== "waiting",
  );
  const attention = total?.filter(
    (e) => !e.hidden && ["failed", "review", "unreachable"].includes(e.state),
  ).length;
  return (
    <div className="contact-summary">
      <div className="contact-totals">
        <p>
          전체 <strong>{total?.length ?? "—"}</strong>명
        </p>
        {view.tab === "waitlist" && (
          <p className="contact-eligible">
            선정 가능한 대기자 <strong>{view.snapshot?.eligibleCount ?? "확인 불가"}</strong>명
          </p>
        )}
        <p>
          확인 필요 <strong>{attention ?? "—"}</strong>명
        </p>
        <p>
          숨김 <strong>{total?.filter((e) => e.hidden).length ?? "—"}</strong>명
        </p>
      </div>
      <a href={view.action}>상태 새로고침</a>
    </div>
  );
}
function Results({ view }: { view: ContactView }) {
  const all = view.snapshot?.entries;
  if (!all)
    return (
      <output>연결 실패로 목록을 확인하지 못했습니다. API 연결 설정 후 다시 조회해 주세요.</output>
    );
  const entries = filterContacts(all, view.query, view.tab === "first-contacts");
  const total = all.filter((e) => view.tab === "waitlist" || e.state !== "waiting");
  return (
    <>
      <output className="catalog-result-count">
        검색 결과 <strong>{entries.length}</strong>명
      </output>
      {entries.length ? (
        <ContactRows entries={entries} view={view} />
      ) : (
        <div className="empty">
          <p>
            {total.length
              ? "조건에 맞는 기록이 없습니다."
              : view.tab === "waitlist"
                ? "대기 등록이 없습니다."
                : "첫 연락 예약이 없습니다."}
          </p>
          {Boolean(total.length) && <a href={`/${view.tab}`}>필터 초기화</a>}
        </div>
      )}
    </>
  );
}
export function ContactPage({ view }: { view: ContactView }) {
  if (view.tab === "invitations") return <InvitationPage view={view} />;
  return (
    <section
      className="contact-management"
      aria-label="대기자와 첫 연락 관리"
      data-contact-management
    >
      <Summary view={view} />
      {view.notice && <output className="contact-notice">{view.notice}</output>}
      <ContactFilters view={view} />
      <div className="contact-actions">
        <BulkActions view={view} />
        {view.tab === "waitlist" && <RandomSelection view={view} />}
      </div>
      <details className="contact-policy">
        <summary>선정·숨김 처리 기준</summary>
        <p className="hint">
          공개 Like 후보 중 현재 배정이 5명 미만이고 이 연락처와 관계를 종료한 적 없는 페르소나를
          지정하거나 무작위로 배정합니다. 선정 후 5분~1시간 뒤 첫 연락을 예약합니다. 테스트 연락처와
          실패·불확실한 첫 연락도 배정 수에 포함합니다.
        </p>
        <p className="hint">
          숨긴 기록은 신규 선정에서 제외됩니다. 이미 예약된 첫 연락과 진행 중인 대화는 유지되며,
          숨긴 기록 필터에서 복원할 수 있습니다.
        </p>
      </details>
      {view.languages && (
        <section className="contact-panel" aria-label="현재 대화의 언어 실력">
          <h2>현재 대화의 언어 실력</h2>
          <LanguageReadout languages={view.languages.languages} />
          {view.languages.lastStateChange && (
            <p>
              최근 State 변경: {view.languages.lastStateChange.at} —{" "}
              {view.languages.lastStateChange.reason}
            </p>
          )}
          <p className="hint">
            이 대화에서 학습한 현재 실력입니다. Discovery에는 초기 실력이 표시됩니다.
          </p>
        </section>
      )}
      {view.selection && (
        <section className="contact-panel" aria-label="이번 선정 결과">
          <h2>
            요청 {view.selection.requested}명 · 실제 선정 {view.selection.entries.length}명
          </h2>
          <ContactRows entries={view.selection.entries} />
        </section>
      )}
      <Results view={view} />
      {view.tab === "first-contacts" && (
        <p className="hint">
          결과 확인 필요·실패 건은 자동 재발송하지 않습니다. 운영자가 기록된 발송 결과와 OpenCode
          세션을 확인해야 합니다. 배정은 유지됩니다.
        </p>
      )}
    </section>
  );
}
