import type {
  ConversationList,
  ConversationDetail,
  ConversationQuery,
  ConversationRuntime,
} from "@ren-ai/onboarding";
import type { ConversationEntry } from "@ren-ai/onboarding";
import type { ConversationMessages } from "@ren-ai/onboarding";
import { MessageHistory } from "./conversation-messages.tsx";

export interface ConversationView {
  query: typeof ConversationQuery.Type;
  list?: typeof ConversationList.Type;
  detail?: typeof ConversationDetail.Type;
  runtime?: typeof ConversationRuntime.Type;
  requestId: string;
  queued?: boolean;
  ended?: boolean;
  registrationsBefore?: string;
  messages?: typeof ConversationMessages.Type;
  messagesBefore?: number;
  messagesError?: string;
}
const time = (value: number | null) =>
  value === null ? "—" : new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const deliveries = {
  queued: "대기",
  uncertain: "결과 불확실",
  sent: "발송 확인",
  delivered: "전달 확인",
  failed: "확정 실패",
  cancelled: "작업 없음",
};
const execution = {
  running: "실행 중",
  idle: "유휴",
  missing: "세션 없음",
  unavailable: "조회 실패 — 정지 여부 미확인",
};
const openCodeServer = "https://oc.renai.im";
const startingRelationships = {
  dating: "연인",
  flirting: "썸",
  friends: "친구",
  strangers: "낯선 사이",
};

function Connections({ entries }: { entries: readonly (typeof ConversationEntry.Type)[] }) {
  return (
    <div className="contact-table-wrap">
      <table className="contact-table">
        <caption className="sr-only">사용자와 페르소나의 Conversation 및 OpenCode 연결</caption>
        <thead>
          <tr>
            <th scope="col">사용자</th>
            <th scope="col">페르소나</th>
            <th scope="col">OpenCode Session ID</th>
            <th scope="col">관계·실행 정지</th>
            <th scope="col">최근 활동</th>
            <th scope="col">종료 안내</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <th scope="row">
                <a href={`/conversations/${entry.id}`}>{entry.handle}</a>
                <small>Conversation #{entry.id}</small>
              </th>
              <td>
                <a href={`/personas/${entry.personaID}`}>{entry.personaName}</a>
                <small>{entry.personaID}</small>
              </td>
              <td aria-label={entry.sessionID}>
                <a
                  href={`${openCodeServer}/server/${Buffer.from(openCodeServer).toString("base64url")}/session/${encodeURIComponent(entry.sessionID)}`}
                  target="_blank"
                  rel="noreferrer"
                  title="OpenCode에서 세션 열기 (새 탭)"
                >
                  <code className="conversation-session">{entry.sessionID}</code>
                </a>
              </td>
              <td>
                <strong>{entry.endedAt === null ? "활성" : "종료"}</strong>
                {entry.endedAt === null && (
                  <a href={`/conversations/${entry.id}#relationship-ending`}>관계 정리</a>
                )}
                {entry.endedBy === "operator" && <small>운영자가 관계 종료</small>}
                {entry.endedBy === "user" && <small>사용자가 관계 종료</small>}
                {entry.startingRelationship && (
                  <small>시작 관계: {startingRelationships[entry.startingRelationship]}</small>
                )}
                <small>
                  {entry.endedAt === null
                    ? "실행 상태는 상세에서 확인"
                    : entry.stoppedAt === null
                      ? "정지 미확인"
                      : `정지 확인 ${time(entry.stoppedAt)}`}
                </small>
              </td>
              <td>
                <small>수신 {time(entry.lastReceivedAt)}</small>
                <small>발송 {time(entry.lastSentAt)}</small>
              </td>
              <td>
                {entry.endedAt === null ? (
                  "—"
                ) : (
                  <>
                    <small>인사: {deliveries[entry.farewell]}</small>
                    <small>재선택: {deliveries[entry.notice]}</small>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!entries.length && <p>조건에 맞는 대화가 없습니다.</p>}
    </div>
  );
}

function Detail({ view }: { view: ConversationView }) {
  const detail = view.detail!;
  const runtime = view.runtime!;
  return (
    <>
      <p>
        <a href="/conversations">← 대화 목록</a>
      </p>
      <h1>대화 상태 #{detail.entry.id}</h1>
      {view.queued && (
        <output>복구 작업을 접수했습니다. 상태 다시 확인으로 진행 결과를 확인해 주세요.</output>
      )}
      {view.ended && (
        <output>관계가 종료되었습니다. 실행 정지와 Ren AI 재선택 안내는 별도로 처리됩니다.</output>
      )}
      <Connections entries={[detail.entry]} />
      <MessageHistory view={view} />
      {detail.entry.endedAt === null && (
        <section id="relationship-ending" aria-labelledby="end-title">
          <h2 id="end-title">관계 정리</h2>
          <p>
            이 사용자와 {detail.entry.personaName}의 관계를 영구 종료합니다. 기록은 보존하고 다른
            페르소나를 선택할 수 있는 Ren AI 안내만 보냅니다.
          </p>
          {!detail.entry.key && (
            <p role="alert">
              API에서 관계 식별 정보를 받지 못해 종료할 수 없습니다. 메시징 API 배포 상태를 확인한
              뒤 새로고침해 주세요.
            </p>
          )}
          <form method="post" action={`/conversations/${detail.entry.id}`} className="form-actions">
            <input type="hidden" name="requestId" value={view.requestId} />
            {detail.entry.key && <input type="hidden" name="key" value={detail.entry.key} />}
            <label>
              <input
                type="checkbox"
                name="confirmEnding"
                value="yes"
                required
                disabled={!detail.entry.key}
              />{" "}
              {detail.entry.handle}와 {detail.entry.personaName}의 현재 관계를 종료함을 확인합니다.
            </label>
            <button name="action" value="end" type="submit" disabled={!detail.entry.key}>
              관계 종료
            </button>
            <p className="hint">
              예약 연락과 이후 일반 발신을 차단합니다. 이미 전송 요청된 메시지는 회수하지 않으며,
              실제 실행 정지·안내 전달 결과는 따로 확인합니다.
            </p>
          </form>
        </section>
      )}
      <section aria-labelledby="execution-title">
        <h2 id="execution-title">실제 OpenCode 실행 상태</h2>
        {runtime.failed && (
          <p role="alert">
            마지막 응답 생성 실패 — OpenCode 서버 로그와 애플리케이션 로그를 확인해 주세요.
          </p>
        )}
        <p>
          <strong>{execution[runtime.state]}</strong> · 대기 작업{" "}
          {runtime.pending === null ? "미확인" : `${runtime.pending}개`} · 예약 연락{" "}
          {time(runtime.nextWakeAt)}
        </p>
        <p>
          시작 {time(detail.entry.startedAt)} · 종료 {time(detail.entry.endedAt)}
        </p>
        <a href={`/conversations/${detail.entry.id}`}>상태 다시 확인</a>
        {detail.entry.endedAt !== null && (
          <form method="post" action={`/conversations/${detail.entry.id}`} className="form-actions">
            <input type="hidden" name="requestId" value={view.requestId} />
            <button name="action" value="stop" type="submit">
              실행 정지 재시도
            </button>
            <button
              name="action"
              value="farewell"
              type="submit"
              disabled={!detail.entry.canNotify || detail.entry.farewell !== "failed"}
            >
              실패한 마지막 인사 재시도
            </button>
            <button
              name="action"
              value="notice"
              type="submit"
              disabled={!detail.entry.canNotify || detail.entry.notice === "uncertain"}
            >
              재선택 링크 재안내
            </button>
            <p className="hint">
              결과 불확실 발송은 자동으로 반복하지 않습니다. 재안내는 확인된 발송도 새 메시지로 다시
              보냅니다.
            </p>
          </form>
        )}
      </section>
      <section aria-labelledby="history-title">
        <h2 id="history-title">이 사용자의 관계 이력</h2>
        <Connections entries={detail.history} />
        <a href={`/conversations?filter=all&search=${encodeURIComponent(detail.entry.handle)}`}>
          이 사용자 전체 이력 검색
        </a>
      </section>
      <section aria-labelledby="registrations-title">
        <h2 id="registrations-title">등록·선정·첫 연락 이력</h2>
        <p>25개씩 표시합니다.</p>
        <ul>
          {detail.registrations.map((entry) => (
            <li key={entry.id}>
              <code>{entry.id}</code> · {time(entry.createdAt)} ·{" "}
              {entry.archivedAt === null ? "현재 등록" : "이전 등록"}
              <p>
                페르소나 {entry.personaID ?? "미배정"} · 첫 연락 {entry.state ?? "대기"} · 선정 ID{" "}
                <code>{entry.selectionID ?? "—"}</code>
              </p>
              {entry.archivedAt === null && detail.entry.endedAt === null && (
                <a href={`/first-contacts?languages=${entry.id}`}>현재 언어 실력 보기</a>
              )}
            </li>
          ))}
        </ul>
        {detail.registrationNextBefore && (
          <a
            href={`/conversations/${detail.entry.id}?registrationsBefore=${encodeURIComponent(detail.registrationNextBefore)}`}
          >
            이전 등록 25개
          </a>
        )}
      </section>
    </>
  );
}

export function ConversationPage({ view }: { view: ConversationView }) {
  if (view.detail) return <Detail view={view} />;
  const next = new URLSearchParams({ filter: view.query.filter, search: view.query.search });
  if (view.list?.nextBefore) next.set("before", String(view.list.nextBefore));
  return (
    <>
      <h1>대화 상태</h1>
      <p>
        사용자–페르소나–OpenCode 세션 연결을 확인합니다. 상세 화면에서 실제 실행 상태를 조회할 수
        있습니다.
      </p>
      <form method="get" action="/conversations" className="contact-toolbar">
        <label>
          관계 상태{" "}
          <select name="filter" defaultValue={view.query.filter}>
            <option value="active">활성</option>
            <option value="ended">종료</option>
            <option value="all">전체</option>
          </select>
        </label>
        <label>
          연결 검색{" "}
          <input
            name="search"
            maxLength={100}
            defaultValue={view.query.search}
            placeholder="사용자 주소·페르소나 ID·Session ID"
          />
        </label>
        <button type="submit">조회</button>
      </form>
      {view.list && <Connections entries={view.list.entries} />}
      {view.list?.nextBefore && <a href={`/conversations?${next}`}>다음 25개</a>}
    </>
  );
}
