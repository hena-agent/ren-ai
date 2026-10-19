import { useCopy } from "./locale.tsx";
import type { ImageStyle } from "./image-style.ts";
import { landingImage } from "./landing-images.ts";

export function HomeHighlights({ style }: { style: ImageStyle }) {
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
                <strong lang="ko">백도희</strong>
                <span>{home.notificationNow}</span>
              </div>
              <p>{home.greeting}</p>
            </div>
          </div>
          <figcaption>{home.exampleNote}</figcaption>
        </figure>
      </div>
      <div className="home-feature home-exclusive">
        <div className="home-exclusive-copy">
          <div className="home-exclusive-heading">
            <p className="home-eyebrow">{home.exclusiveEyebrow}</p>
            <h2>
              {home.exclusiveTitle}
              <em>{home.exclusiveAccent}</em>
              {home.exclusiveSuffix}
            </h2>
          </div>
          <div className="home-exclusive-body">
            <p>{home.exclusiveBody}</p>
            <p className="home-exclusive-note">{home.exclusiveNote}</p>
          </div>
        </div>
        <figure className="home-connection" aria-label={home.exclusiveExample}>
          <div className="home-connection-persona">
            <div className="home-connection-avatar">
              <img
                className="home-exclusive-image"
                src={landingImage("dohee-exclusive", style)}
                width="112"
                height="112"
                alt={home.exclusivePhoto}
                loading="lazy"
              />
            </div>
            <strong lang="ko">백도희</strong>
            <span>{home.personaLabel}</span>
          </div>
          <div className="home-connection-link" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
            </svg>
          </div>
          <div className="home-connection-recipient">
            <div className="home-connection-you">{home.exclusiveYou}</div>
            <span>{home.exclusiveRecipient}</span>
          </div>
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
