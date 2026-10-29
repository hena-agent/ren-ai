import type { ContactEntry } from "@ren-ai/onboarding";
import type { ContactView } from "./contact-page.tsx";
import { contactStates } from "./contact-query.ts";

const reasons = {
  ready: "선정 가능",
  blocked: "차단·삭제 처리 중",
  active: "이미 대화 중",
  reserved: "배정됨",
  no_persona: "배정 여유가 있는 공개 Like 후보 없음",
  no_imessage: "iMessage 미지원",
  imessage_unverified: "iMessage 확인 전 선정 보류",
};
const notifications = {
  queued: "안내 대기 중",
  sent: "안내 보냄",
  failed: "안내 실패",
  uncertain: "안내 결과 불확실",
  skipped: "안내 생략 (시간당 한도)",
};
const imessage = { available: "사용 가능", unavailable: "미지원", failed: "확인 실패" };
const time = (at: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(at);
type Entry = typeof ContactEntry.Type;

function AssignmentChoice({ entry, view }: { entry: Entry; view: ContactView }) {
  return (
    <details className="contact-detail">
      <summary>배정 페르소나 선택</summary>
      <label>
        배정할 페르소나
        <select
          name={`personaID:${entry.id}`}
          form="contact-direct-selection"
          aria-label={`${entry.handle} 배정할 페르소나`}
          defaultValue={
            view.assignments.find((a) => a.registrationID === entry.id)?.personaID ?? ""
          }
          disabled={!entry.eligible || view.directAttempted}
        >
          <option value="">무작위 배정</option>
          {entry.assignablePersonas?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {!entry.assignablePersonas && (
          <small>지정 후보를 불러오려면 메시징 API 배포 상태를 확인해 주세요.</small>
        )}
      </label>
    </details>
  );
}
function RowActions({ entry, view }: { entry: Entry; view: ContactView }) {
  return (
    <div className="contact-row-actions">
      <form action={view.action} method="post">
        <input type="hidden" name="registrationIDs" value={entry.id} />
        <button
          type="submit"
          name="action"
          value={entry.hidden ? "restore" : "hide"}
          className="secondary"
          aria-label={`${entry.handle} ${entry.hidden ? "복원" : "숨기기"}`}
        >
          {entry.hidden ? "복원" : "숨기기"}
        </button>
      </form>
      {view.tab === "waitlist" && entry.testHandle && entry.eligible && (
        <details className="contact-detail">
          <summary>테스트 바로 시작</summary>
          <form action={view.action} method="post" className="contact-test-start">
            <input type="hidden" name="action" value="start" />
            <input type="hidden" name="requestId" value={view.startRequestId} />
            <input type="hidden" name="registrationID" value={entry.id} />
            <label>
              Like 페르소나
              <select name="personaID" required>
                {entry.likedPersonas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">지금 시작</button>
          </form>
        </details>
      )}
    </div>
  );
}
function Status({ entry }: { entry: Entry }) {
  return (
    <>
      <span className="contact-status" data-state={entry.relationshipEnd ? "ended" : entry.state}>
        {entry.relationshipEnd ? "관계 종료" : contactStates[entry.state]}
      </span>
      {entry.hidden && <small>숨긴 기록 · 신규 선정 제외</small>}
      <small>
        {entry.relationshipEnd
          ? entry.relationshipEnd.noticeDelivered
            ? "재선택 안내 발송 완료"
            : "종료 안내 발송 확인 필요"
          : entry.hidden
            ? "목록에서 숨김"
            : reasons[entry.reason]}
      </small>
      {(entry.requestId || entry.notification || entry.relationshipEnd) && (
        <details className="contact-detail">
          <summary>처리 상세</summary>
          {entry.requestId && <small>요청 ID: {entry.requestId}</small>}
          {entry.notification && <small>{notifications[entry.notification]}</small>}
          {entry.relationshipEnd && <small>{time(entry.relationshipEnd.at)}</small>}
        </details>
      )}
    </>
  );
}
export function ContactRows({ entries, view }: { entries: readonly Entry[]; view?: ContactView }) {
  return (
    <section className="contact-table" aria-label="연락처 목록">
      <table>
        <caption className="sr-only">연락처·Like·배정·첫 연락 상태</caption>
        <thead>
          <tr>
            {view && (
              <th scope="col">
                <input
                  type="checkbox"
                  data-contact-all
                  aria-label="현재 목록 전체 선택"
                  disabled={view.directAttempted}
                />
              </th>
            )}
            <th scope="col">연락처 / 등록</th>
            <th scope="col">iMessage</th>
            <th scope="col">Like한 페르소나</th>
            <th scope="col">배정 / 예정 시각</th>
            <th scope="col">상태</th>
            {view && <th scope="col">작업</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              {view && (
                <td>
                  <input
                    type="checkbox"
                    name="registrationIDs"
                    value={entry.id}
                    form="contact-direct-selection"
                    aria-label={`${entry.handle} 선정`}
                    data-contact-select
                    data-eligible={String(entry.eligible)}
                    defaultChecked={view.registrationIDs.includes(entry.id)}
                    disabled={view.directAttempted}
                  />
                </td>
              )}
              <th scope="row">
                <span className="contact-handle">{entry.handle}</span>
                {entry.testHandle && <small>테스트 연락처</small>}
                <small>{time(entry.createdAt)}</small>
                {entry.handle.startsWith("+") && (
                  <a
                    className="contact-meta-link"
                    href={`/invitations?section=phone&handle=${encodeURIComponent(entry.handle)}`}
                  >
                    초대장 관리
                  </a>
                )}
                {entry.state === "active" && !entry.relationshipEnd && (
                  <a className="contact-meta-link" href={`/first-contacts?languages=${entry.id}`}>
                    현재 언어 실력
                  </a>
                )}
              </th>
              <td>
                {entry.imessage ? (
                  <>
                    {imessage[entry.imessage.status]}
                    <small>{time(entry.imessage.checkedAt)}</small>
                    {entry.imessage.reason && <small>{entry.imessage.reason}</small>}
                    {entry.imessage.status === "unavailable" && (
                      <small>조회에서 수신 기기를 찾지 못했습니다.</small>
                    )}
                  </>
                ) : (
                  "미확인"
                )}
                {view && (
                  <form action={view.action} method="post">
                    <input type="hidden" name="registrationID" value={entry.id} />
                    <button
                      type="submit"
                      name="action"
                      value="imessage-recheck"
                      className="secondary"
                      aria-label={`${entry.handle} iMessage 재확인`}
                    >
                      재확인
                    </button>
                  </form>
                )}
              </td>
              <td>{entry.likedPersonas.map((p) => p.name).join(", ") || "없음"}</td>
              <td>
                {entry.persona ? (
                  <>
                    <a href={`/personas/${entry.persona.id}`}>{entry.persona.name}</a>
                    <small>
                      {entry.scheduledAt === null ? "예정 시각 없음" : time(entry.scheduledAt)}
                    </small>
                  </>
                ) : view?.tab === "waitlist" ? (
                  <AssignmentChoice entry={entry} view={view} />
                ) : (
                  "미배정"
                )}
              </td>
              <td>
                <Status entry={entry} />
              </td>
              {view && (
                <td>
                  <RowActions entry={entry} view={view} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
