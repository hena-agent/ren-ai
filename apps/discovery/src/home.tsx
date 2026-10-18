import { useEffect } from "react";
import { Header } from "./chrome.tsx";
import { useCopy } from "./locale.tsx";
import { PrivacyDisclosure } from "./privacy-disclosure.tsx";

function ExploreLink() {
  const copy = useCopy();
  return (
    <a className="home-cta" href="/explore">
      {copy.home.start}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

export function Home() {
  const copy = useCopy();
  const home = copy.home;
  useEffect(() => {
    document.title = home.pageTitle;
  }, [home.pageTitle]);
  return (
    <div className="home">
      <Header>
        <nav className="home-nav" aria-label={home.navigation}>
          <a href="#about">{home.about}</a>
          <a href="#how-it-works">{home.how}</a>
          <a href="#faq">{home.faq}</a>
        </nav>
      </Header>
      <main id="discovery-content">
        <section className="home-hero" aria-labelledby="home-title">
          <div className="home-hero-copy">
            <p className="home-eyebrow">
              <span aria-hidden="true" />
              {home.eyebrow}
            </p>
            <h1 id="home-title">
              {home.title}
              <span>{home.titleAccent}</span>
            </h1>
            <p className="home-intro">{home.intro}</p>
            <div className="home-actions">
              <ExploreLink />
              <a className="home-secondary" href="#how-it-works">
                {home.how}
                <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="home-waiting">{home.waiting}</p>
          </div>
          <figure className="home-conversation" aria-label={home.exampleLabel}>
            <div className="home-conversation-heading">
              <span aria-hidden="true" className="icon icon-heart" />
              {home.example}
              <span aria-hidden="true">iMessage</span>
            </div>
            <div className="home-messages">
              {home.messages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
            <figcaption>{home.exampleNote}</figcaption>
          </figure>
          <div className="home-hero-index" aria-hidden="true">
            <span>Ren AI</span>
            <span>01 — A new connection</span>
          </div>
        </section>
        <section className="home-section" id="about" aria-labelledby="about-title">
          <p className="home-eyebrow">{home.aboutEyebrow}</p>
          <h2 id="about-title">{home.aboutTitle}</h2>
          <div className="home-features">
            {home.features.map((feature, index) => (
              <article key={feature.title}>
                <span className="home-number" aria-hidden="true">
                  0{index + 1}
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="home-how" id="how-it-works" aria-labelledby="how-title">
          <div>
            <p className="home-eyebrow">{home.howEyebrow}</p>
            <h2 id="how-title">{home.howTitle}</h2>
          </div>
          <div>
            <ol className="home-steps">
              {home.steps.map((step) => (
                <li key={step.title}>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
            <p className="home-selection-note">{home.selectionNote}</p>
          </div>
        </section>
        <section className="home-faq home-section" id="faq" aria-labelledby="faq-title">
          <div>
            <p className="home-eyebrow">{home.faq}</p>
            <h2 id="faq-title">{home.faqTitle}</h2>
          </div>
          <div className="home-questions">
            {home.questions.map((question) => (
              <details key={question.title}>
                <summary>
                  {question.title}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{question.body}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="home-closing" aria-labelledby="closing-title">
          <span className="icon icon-heart" aria-hidden="true" />
          <h2 id="closing-title">{home.closingTitle}</h2>
          <p>{home.closingBody}</p>
          <ExploreLink />
        </section>
      </main>
      <footer className="home-footer">
        <div>
          <a className="wordmark" href="/">
            {copy.brand}
          </a>
          <p>{home.footer}</p>
        </div>
        <PrivacyDisclosure />
      </footer>
    </div>
  );
}
