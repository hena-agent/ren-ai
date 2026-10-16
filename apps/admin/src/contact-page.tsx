import type {
  ContactEntry,
  ContactSnapshot,
  ContactSelection,
  ContactState,
} from "@ren-ai/onboarding";

export interface ContactView {
  tab: "waitlist" | "first-contacts";
  requestId: string;
  startRequestId: string;
  directRequestId: string;
  registrationIDs: readonly string[];
  directAttempted?: boolean;
  count: number;
  attempted?: boolean;
  snapshot?: typeof ContactSnapshot.Type;
  selection?: typeof ContactSelection.Type;
}
const labels: Record<typeof ContactState.Type, string> = {
  waiting: "대기 중",
  scheduled: "첫 연락 예약",
  preparing: "대화 준비 중",
  greeting: "첫 인사 처리 중",
  active: "대화 시작",
  failed: "첫 연락 실패",
  review: "결과 확인 필요",
  blocked: "차단·후보 사용 불가",
  unreachable: "연락처 수정 필요",
};
const reasons = {
  ready: "선정 가능",
  blocked: "차단·삭제 처리 중",
  active: "이미 대화 중",
  reserved: "배정됨",
  no_persona: "공개된 미배정 Like 후보 없음",
};
const time = (at: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(at);
function Rows({
  entries,
  selection,
}: {
  entries: readonly (typeof ContactEntry.Type)[];
  selection?: ContactView;
}) {
  return (
    <div className="contact-table">
      <table>
        <caption>연락처·Like·배정·첫 연락 상태</caption>
        <thead>
          <tr>
            {selection && <th scope="col">선정</th>}
            <th scope="col">연락처 / 등록</th>
            <th scope="col">Like한 페르소나</th>
            <th scope="col">배정 / 예정 시각</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              {selection && (
                <td>
                  <label className="contact-confirm">
                    <input
                      type="checkbox"
                      name="registrationIDs"
                      value={entry.id}
                      form="contact-direct-selection"
                      aria-label={`${entry.handle} 선정`}
                      defaultChecked={selection.registrationIDs.includes(entry.id)}
                      disabled={!entry.eligible || selection.directAttempted}
                    />
                  </label>
                </td>
              )}
              <th scope="row">
                <span className="contact-handle">{entry.handle}</span>
                {entry.testHandle && <small>테스트 연락처</small>}
                <small>{time(entry.createdAt)}</small>
              </th>
              <td>{entry.likedPersonas.map((p) => p.name).join(", ") || "없음"}</td>
              <td>
                {entry.persona ? (
                  <>
                    <a href={`/personas/${entry.persona.id}`}>{entry.persona.name}</a>
                    <small>
                      {entry.scheduledAt === null ? "예정 시각 없음" : time(entry.scheduledAt)}
                    </small>
                  </>
                ) : (
                  "미배정"
                )}
              </td>
              <td>
                <strong>{labels[entry.state]}</strong>
                <small>{reasons[entry.reason]}</small>
                {entry.requestId && <small>요청 ID: {entry.requestId}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function TestStarts({
  entries,
  requestId,
}: {
  entries: readonly (typeof ContactEntry.Type)[];
  requestId: string;
}) {
  const ready = entries.filter((entry) => entry.testHandle && entry.eligible);
  if (!ready.length) return null;
  return (
    <section className="contact-test-start" aria-label="테스트 연락처 바로 시작">
      <h2>테스트 연락처 바로 시작</h2>
      <p className="hint">
        무작위 선정과 대기 시간 없이, 고른 Like 페르소나가 지금 첫 연락을 시작합니다.
      </p>
      {ready.map((entry) => (
        <form key={entry.id} action="/waitlist" method="post" className="contact-selection">
          <input type="hidden" name="action" value="start" />
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="registrationID" value={entry.id} />
          <label htmlFor={`start-${entry.id}`}>{entry.handle}</label>
          <select id={`start-${entry.id}`} name="personaID" required>
            {entry.likedPersonas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
          <label className="contact-confirm">
            <input type="checkbox" name="confirm" value="yes" required /> 고른 페르소나로 지금 첫
            연락을 시작합니다.
          </label>
          <button type="submit">지금 시작</button>
        </form>
      ))}
    </section>
  );
}
function DirectSelection({ view }: { view: ContactView }) {
  return (
    <form
      id="contact-direct-selection"
      action="/waitlist"
      method="post"
      className="contact-selection"
    >
      <h2>대기자 직접 선정</h2>
      <p>
        아래 목록에서 대기자를 선택하세요. Like한 페르소나를 무작위로 배정하고, 동일하게 5분~1시간
        뒤 첫 연락을 예약합니다.
      </p>
      <input type="hidden" name="action" value="select-specific" />
      <input type="hidden" name="requestId" value={view.directRequestId} />
      {view.directAttempted &&
        view.registrationIDs.map((id) => (
          <input key={id} type="hidden" name="registrationIDs" value={id} />
        ))}
      <label className="contact-confirm">
        <input type="checkbox" name="confirm" value="yes" required /> 선택한 대기자의 독점 배정·첫
        연락 예약을 실행합니다.
      </label>
      <button type="submit" disabled={!view.directAttempted && !view.snapshot?.eligibleCount}>
        {view.directAttempted ? "같은 직접 선정 요청 확인" : "선택한 대기자 선정하기"}
      </button>
      <p className="hint">
        선정 시점에 배정 가능한 선택 인원만 처리합니다. 실패 시 같은 요청으로 재시도하며, 선택하지
        않은 대기자는 선정하지 않습니다.
      </p>
    </form>
  );
}
export function ContactPage({ view }: { view: ContactView }) {
  const entries = view.snapshot?.entries.filter(
    (row) => view.tab === "waitlist" || row.state !== "waiting",
  );
  return (
    <section className="contact-management" aria-label="대기자와 첫 연락 관리">
      <p>
        한 페르소나는 한 사용자에게만 배정됩니다. 선정 후 5분~1시간 사이에 첫 인사를 시도합니다.
      </p>
      <a href={view.tab === "waitlist" ? "/waitlist" : "/first-contacts"}>상태 새로고침</a>
      {view.tab === "waitlist" && (
        <form action="/waitlist" method="post" className="contact-selection">
          <p>
            선정 가능한 대기자 <strong>{view.snapshot?.eligibleCount ?? "확인 불가"}</strong>명
          </p>
          <input type="hidden" name="requestId" value={view.requestId} />
          <label htmlFor="contact-count">선정할 인원</label>
          <input
            id="contact-count"
            type="number"
            name="count"
            min="1"
            max="100"
            required
            defaultValue={view.count}
          />
          <label className="contact-confirm">
            <input type="checkbox" name="confirm" value="yes" required /> 무작위 선정·독점 배정·첫
            연락 예약을 실행합니다.
          </label>
          <button
            type="submit"
            disabled={!view.attempted && (!view.snapshot || view.snapshot.eligibleCount === 0)}
          >
            {view.attempted ? "같은 선정 요청 확인" : "N명 선정하기"}
          </button>
          <p className="hint">
            후보가 부족하면 가능한 인원만 선정합니다. 실패 시 같은 요청 ID로 재제출하면 중복
            선정하지 않습니다.
          </p>
        </form>
      )}
      {view.tab === "waitlist" && view.snapshot && (
        <TestStarts entries={view.snapshot.entries} requestId={view.startRequestId} />
      )}
      {view.tab === "waitlist" && <DirectSelection view={view} />}
      {view.selection && (
        <section aria-label="이번 선정 결과">
          <h2>
            요청 {view.selection.requested}명 · 실제 선정 {view.selection.entries.length}명
          </h2>
          <Rows entries={view.selection.entries} />
        </section>
      )}
      {entries ? (
        entries.length ? (
          <Rows entries={entries} {...(view.tab === "waitlist" && { selection: view })} />
        ) : (
          <p className="empty">
            {view.tab === "waitlist" ? "대기 등록이 없습니다." : "첫 연락 예약이 없습니다."}
          </p>
        )
      ) : (
        <p>연결 실패로 목록을 확인하지 못했습니다. API 연결 설정 후 다시 조회해 주세요.</p>
      )}
      {view.tab === "first-contacts" && (
        <p className="hint">
          결과 확인 필요·실패 건은 자동 재발송하지 않습니다. 운영자가 기록된 발송 결과와 OpenCode
          세션을 확인해야 합니다. 배정은 유지됩니다.
        </p>
      )}
    </section>
  );
}
