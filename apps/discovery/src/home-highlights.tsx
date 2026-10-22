import { useCopy } from "./locale.tsx";

export function HomeHighlights() {
  const { home } = useCopy();
  return (
    <section className="home-how" id="how-it-works" aria-labelledby="how-title">
      <div className="home-feature home-installation">
        <div className="home-feature-copy">
          <p className="home-eyebrow">{home.installEyebrow}</p>
          <h2 id="how-title">
            {home.installTitle}
            <span>{home.installAccent}</span>
          </h2>
          <p>{home.installBody}</p>
          <div className="home-channel">
            <img src="/icons/imessage.svg" width="48" height="48" alt="" />
            <span>
              <strong>iMessage</strong>
              <span>{home.channelNote}</span>
            </span>
          </div>
        </div>
        <figure className="home-message-arrival" aria-label={home.notificationLabel}>
          <div className="home-message-route" aria-hidden="true">
            <img src="/brand.svg" width="40" height="40" alt="" />
            <span />
            <img src="/icons/imessage.svg" width="48" height="48" alt="" />
          </div>
          <div className="home-notification">
            <img src="/icons/imessage.svg" width="48" height="48" alt="" />
            <div>
              <div className="home-notification-sender">
                <strong>{home.personaNames.dohee}</strong>
                <span>{home.notificationNow}</span>
              </div>
              <p>{home.greeting}</p>
            </div>
          </div>
          <figcaption>{home.exampleNote}</figcaption>
        </figure>
      </div>
      <div className="home-start">
        <h3>{home.howTitle}</h3>
        <ol className="home-steps">
          {home.steps.map((step, index) => (
            <li key={step.title}>
              <span aria-hidden="true">0{index + 1}</span>
              <div>
                <h4>{step.title}</h4>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="home-selection-note">{home.selectionNote}</p>
      </div>
    </section>
  );
}
