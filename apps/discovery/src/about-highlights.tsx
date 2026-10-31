import { useCopy } from "./locale.tsx";

export function AboutHighlights() {
  const { about } = useCopy();
  return (
    <section className="about-how" id="how-it-works" aria-labelledby="how-title">
      <div className="about-feature about-installation">
        <div className="about-feature-copy">
          <p className="about-eyebrow">{about.installEyebrow}</p>
          <h2 id="how-title">
            {about.installTitle}
            <span>{about.installAccent}</span>
          </h2>
          <p>{about.installBody}</p>
          <div className="about-channel">
            <img src="/icons/imessage.svg" width="48" height="48" alt="" />
            <span>
              <strong>iMessage</strong>
              <span>{about.channelNote}</span>
            </span>
          </div>
        </div>
        <figure className="about-message-arrival" aria-label={about.notificationLabel}>
          <div className="about-message-route" aria-hidden="true">
            <img src="/brand.svg" width="40" height="40" alt="" />
            <span />
            <img src="/icons/imessage.svg" width="48" height="48" alt="" />
          </div>
          <div className="about-notification">
            <img src="/icons/imessage.svg" width="48" height="48" alt="" />
            <div>
              <div className="about-notification-sender">
                <strong>{about.personaNames.dohee}</strong>
                <span>{about.notificationNow}</span>
              </div>
              <p>{about.greeting}</p>
            </div>
          </div>
          <figcaption>{about.exampleNote}</figcaption>
        </figure>
      </div>
      <div className="about-start">
        <h3>{about.howTitle}</h3>
        <ol className="about-steps">
          {about.steps.map((step, index) => (
            <li key={step.title}>
              <span aria-hidden="true">0{index + 1}</span>
              <div>
                <h4>{step.title}</h4>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="about-selection-note">{about.selectionNote}</p>
      </div>
    </section>
  );
}
