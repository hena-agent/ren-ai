import { useEffect } from "react";
import { Header } from "./chrome.tsx";
import { useCopy } from "./locale.tsx";
import { PrivacyDisclosure } from "./privacy-disclosure.tsx";
import { HomeNavigation } from "./home-navigation.tsx";
import { HeroGallery, ConversationArtwork } from "./home-artwork.tsx";

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
        <HomeNavigation />
      </Header>
      <main id="discovery-content">
        <section className="home-hero" aria-labelledby="home-title">
          <HeroGallery />
          <div className="home-hero-copy">
            <p className="home-eyebrow">{home.eyebrow}</p>
            <h1 id="home-title">
              {home.title}
              <span>{home.titleAccent}</span>
            </h1>
            <div className="home-hero-bottom">
              <p className="home-intro">{home.heroIntro}</p>
              <ExploreLink />
            </div>
          </div>
          <a className="home-scroll" href="#about" aria-label={home.about}>
            <span aria-hidden="true">↓</span>
          </a>
        </section>
        <p className="home-notice">
          <span aria-hidden="true" />
          {home.waiting}
        </p>

        <section className="home-conversation" id="about" aria-labelledby="about-title">
          <div className="home-conversation-copy">
            <p className="home-eyebrow">{home.aboutEyebrow}</p>
            <h2 id="about-title">
              {home.conversationTitle}
              <span>{home.conversationAccent}</span>
            </h2>
            <p className="home-section-intro">{home.features[1]!.body}</p>
            <p className="home-conversation-note">{home.features[2]!.body}</p>
          </div>
          <div className="home-conversation-stage">
            <ConversationArtwork />
          </div>
        </section>

        <section className="home-story" aria-labelledby="story-title">
          <figure className="home-story-photo">
            <img
              src="/landing/seowoo-daily.webp"
              width="640"
              height="794"
              alt={`한서우 ${copy.profilePhoto}`}
              loading="lazy"
            />
            <figcaption>
              <span lang="ko">한서우</span>
              <span>{home.personaLabel}</span>
            </figcaption>
          </figure>
          <div className="home-story-copy">
            <p className="home-eyebrow">{home.profileNote}</p>
            <h2 id="story-title">{home.aboutTitle}</h2>
            <p className="home-section-intro">{home.features[0]!.body}</p>
          </div>
        </section>

        <section className="home-how" id="how-it-works" aria-labelledby="how-title">
          <div className="home-section-heading">
            <p className="home-eyebrow">{home.howEyebrow}</p>
            <h2 id="how-title">{home.howTitle}</h2>
          </div>
          <ol className="home-steps">
            {home.steps.map((step, index) => (
              <li key={step.title}>
                <span aria-hidden="true">0{index + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
          <p className="home-selection-note">{home.selectionNote}</p>
        </section>

        <section className="home-faq" id="faq" aria-labelledby="faq-title">
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
          <p className="home-eyebrow">Ren AI</p>
          <h2 id="closing-title">{home.closingTitle}</h2>
          <div>
            <p>{home.closingBody}</p>
            <ExploreLink />
          </div>
        </section>
      </main>
      <footer className="home-footer">
        <div>
          <a className="wordmark" href="/">
            <img src="/brand.svg" width="30" height="30" alt="" />
            {copy.brand}
          </a>
          <p>{home.footer}</p>
        </div>
        <PrivacyDisclosure />
      </footer>
    </div>
  );
}
