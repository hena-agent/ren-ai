import { useEffect } from "react";
import { Header } from "./chrome.tsx";
import { useCopy } from "./locale.tsx";
import { PrivacyDisclosure } from "./privacy-disclosure.tsx";
import { HomeNavigation } from "./home-navigation.tsx";
import { HeroGallery } from "./home-artwork.tsx";
import { ConversationScene } from "./conversation-scene.tsx";
import { useImageStyle } from "./use-image-style.ts";
import { StyleSwitch, StyleFeedback } from "./style-switch.tsx";
import { HomeHighlights } from "./home-highlights.tsx";
import { landingImage } from "./landing-images.ts";
import { useActivity } from "./activity.ts";
import { discoveryClient, type DiscoveryClient } from "./client.ts";

function ExploreLink() {
  const copy = useCopy();
  return (
    <a className="home-cta" href="/explore">
      {copy.home.start}
      <span className="icon icon-external" aria-hidden="true" />
    </a>
  );
}

export function Home({ client = discoveryClient }: { client?: DiscoveryClient }) {
  const copy = useCopy();
  const home = copy.home;
  const { style, issue, choose } = useImageStyle();
  useActivity(client, style);
  useEffect(() => {
    document.title = home.pageTitle;
  }, [home.pageTitle]);
  return (
    <div className="home">
      <Header>
        <StyleSwitch style={style} onChoose={choose} />
        <HomeNavigation />
      </Header>
      <StyleFeedback issue={issue} />
      <main id="discovery-content">
        <section className="home-hero" aria-labelledby="home-title">
          <HeroGallery style={style} />
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
            <span className="icon icon-down" aria-hidden="true" />
          </a>
        </section>
        <p className="home-notice">
          <span aria-hidden="true" />
          {home.waiting}
        </p>

        <section className="home-conversation" id="about" aria-labelledby="about-title">
          <div className="home-conversation-copy">
            <div>
              <p className="home-eyebrow">{home.aboutEyebrow}</p>
              <h2 id="about-title">
                {home.conversationTitle}
                <span>{home.conversationAccent}</span>
              </h2>
            </div>
            <div>
              <p className="home-section-intro">{home.features[1]!.body}</p>
              <p className="home-conversation-note">{home.features[2]!.body}</p>
            </div>
          </div>
          <ConversationScene style={style} />
        </section>

        <HomeHighlights />

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
                  <span className="icon icon-plus" aria-hidden="true" />
                </summary>
                <p>{question.body}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="home-closing" aria-labelledby="closing-title">
          <div className="home-closing-copy">
            <p className="home-eyebrow">Ren AI</p>
            <h2 id="closing-title">
              {home.closingTitle}
              <span>{home.closingAccent}</span>
            </h2>
            <p>{home.closingBody}</p>
            <ExploreLink />
          </div>
          <figure className="home-closing-photo">
            <img
              src={landingImage("dohee-daily", style)}
              width="928"
              height="1152"
              alt={home.dailyPhoto}
              loading="lazy"
            />
            <figcaption>
              <span className="home-greeting-name">
                <span className="icon icon-message" aria-hidden="true" />
                <span>{home.personaNames.dohee}</span>
                <span>iMessage</span>
              </span>
              <p>{home.greeting}</p>
              <small>{home.exampleNote}</small>
            </figcaption>
          </figure>
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
