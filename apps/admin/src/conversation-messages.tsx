import type { ConversationMessages } from "@ren-ai/onboarding";
import type { ConversationView } from "./conversation-page.tsx";

type Message = (typeof ConversationMessages.Type)["entries"][number];
const states = {
  pending: "전송 대기 · 결과 미확정",
  sent: "발송 확인",
  delivered: "전달 확인",
  failed: "전송 실패",
};
const formatTime = (at: number) => new Date(at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

function Bubble({ message, view }: { message: Message; view: ConversationView }) {
  const { entry } = view.detail!;
  const reply = view.messages!.entries.find((row) => row.guid === message.replyToGuid);
  return (
    <li
      className={`message-row${message.fromMe ? " message-outgoing" : ""}`}
      id={`message-${message.guid}`}
    >
      <article
        className="message-bubble"
        aria-label={message.fromMe ? "발신 메시지" : "수신 메시지"}
      >
        <header>
          <strong>{message.fromMe ? entry.personaName : "사용자"}</strong>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {formatTime(message.createdAt)}
          </time>
        </header>
        {message.replyToGuid && (
          <blockquote>
            {reply ? (
              <a href={`#message-${reply.guid}`}>답장: {reply.text || "첨부 메시지"}</a>
            ) : (
              "이전 메시지에 답장"
            )}
          </blockquote>
        )}
        {message.tapback && (
          <p>
            리액션 {message.tapback.added ? "추가" : "취소"}: {message.tapback.emoji}
          </p>
        )}
        {message.text && <p className="message-text">{message.text}</p>}
        {message.attachments.map((attachment, index) => (
          <p key={index} className="message-attachment">
            {attachment.mimeType?.startsWith("image/") ? "사진" : "첨부파일"}
            {attachment.missing ? " · 파일 없음" : " · 첨부됨"}
          </p>
        ))}
        {message.payload && (
          <p>{message.payload === "location" ? "위치 공유" : "iMessage 앱 콘텐츠"}</p>
        )}
        {!message.text && !message.tapback && !message.attachments.length && !message.payload && (
          <p className="hint">본문 없음 · 전송 취소되었거나 표시할 수 없는 메시지</p>
        )}
        {message.fromMe && message.status && (
          <footer>
            {message.status.dateRead !== null
              ? `읽음 · ${formatTime(message.status.dateRead)}`
              : states[message.status.state]}
            {message.status.state === "failed" && ` · 오류 ${message.status.error}`}
          </footer>
        )}
      </article>
    </li>
  );
}

export function MessageHistory({ view }: { view: ConversationView }) {
  const path = `/conversations/${view.detail!.entry.id}`;
  const retry = `${path}${view.messagesBefore === undefined ? "" : `?messagesBefore=${view.messagesBefore}`}#messages`;
  return (
    <section className="message-history" id="messages" aria-labelledby="messages-title">
      <div className="queue-heading">
        <h2 id="messages-title">송수신 내역</h2>
        <a href={`${path}#messages`}>최신 내역 새로고침</a>
      </div>
      <p className="hint">실제 메시징 기록 · 한국 시간(KST) · 한 페이지 최대 50개</p>
      {view.messagesError ? (
        <div role="alert">
          <p>{view.messagesError}</p>
          <a href={retry}>내역 다시 불러오기</a>
        </div>
      ) : (
        <>
          {view.messages?.nextBefore !== null && view.messages?.nextBefore !== undefined && (
            <a
              className="message-older"
              href={`${path}?messagesBefore=${view.messages.nextBefore}#messages`}
            >
              이전 대화 보기
            </a>
          )}
          {view.messages?.entries.length ? (
            <ol className="message-list">
              {view.messages.entries.map((message) => (
                <Bubble key={message.id} message={message} view={view} />
              ))}
            </ol>
          ) : (
            <p>이 범위에 저장된 송수신 내역이 없습니다.</p>
          )}
          {view.messagesBefore !== undefined && (
            <p>
              <a href={`${path}#messages`}>최신 대화로 돌아가기</a>
            </p>
          )}
        </>
      )}
    </section>
  );
}
