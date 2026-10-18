import { useCopy } from "./locale.tsx";

export function ConversationScene() {
  const copy = useCopy();
  return (
    <div className="conversation-story">
      <div className="conversation-viewport">
        <figure className="conversation-photo">
          <img
            src="/landing/seowoo-daily.webp"
            width="928"
            height="1152"
            alt={`한서우 ${copy.profilePhoto}`}
            loading="lazy"
          />
        </figure>
        <figure className="conversation-thread" aria-label={copy.home.exampleLabel}>
          <div className="conversation-contact">
            <img src="/landing/seowoo.webp" width="44" height="44" alt="" loading="lazy" />
            <div>
              <strong lang="ko">한서우</strong>
              <span>{copy.home.personaLabel}</span>
            </div>
            <span className="conversation-platform">iMessage</span>
          </div>
          <ol className="conversation-messages">
            {copy.home.messages.map((message, index) => (
              <li
                className="conversation-message"
                data-direction={index === 1 ? "outgoing" : "incoming"}
                key={message}
              >
                <p>{message}</p>
              </li>
            ))}
          </ol>
          <figcaption>{copy.home.exampleNote}</figcaption>
        </figure>
      </div>
    </div>
  );
}
