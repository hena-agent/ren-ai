import type {
  ContactEntry,
  ContactSnapshot,
  ContactSelection,
  ContactState,
} from "@ren-ai/onboarding";

export interface ContactView {
  tab: "waitlist" | "first-contacts";
  requestId: string;
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
function Rows({ entries }: { entries: readonly (typeof ContactEntry.Type)[] }) {
  return (
    <div className="contact-table">
      <table>
        <caption>연락처·Like·배정·첫 연락 상태</caption>
        <thead>
          <tr>
            <th scope="col">연락처 / 등록</th>
            <th scope="col">Like한 페르소나</th>
            <th scope="col">배정 / 예정 시각</th>
            <th scope="col">상태</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <th scope="row">
                <span className="contact-handle">{entry.handle}</span>
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
          <Rows entries={entries} />
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
