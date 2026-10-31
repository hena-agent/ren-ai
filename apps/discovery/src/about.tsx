import { Header } from "./chrome.tsx";
import { useCopy, useLocale } from "./locale.tsx";
import { localizedPath } from "./public-routing.ts";
import { PrivacyDisclosure } from "./privacy-disclosure.tsx";
import { AboutNavigation } from "./about-navigation.tsx";
import { HeroGallery } from "./about-artwork.tsx";
import { ConversationScene } from "./conversation-scene.tsx";
import { useImageStyle } from "./use-image-style.ts";
import { StyleSwitch, StyleFeedback } from "./style-switch.tsx";
import { AboutHighlights } from "./about-highlights.tsx";
import { landingImage } from "./landing-images.ts";
import { useActivity } from "./activity.ts";
import { discoveryClient, type DiscoveryClient } from "./client.ts";
import { useSeo } from "./use-seo.ts";

function ExploreLink() {
  const copy = useCopy();
  const { locale } = useLocale();
  return (
    <a className="about-cta" href={localizedPath("/explore", locale)}>
      {copy.about.start}
      <span className="icon icon-external" aria-hidden="true" />
    </a>
  );
}

export function About({ client = discoveryClient }: { client?: DiscoveryClient }) {
  const copy = useCopy();
  const { locale } = useLocale();
  const about = copy.about;
  const { style, issue, choose } = useImageStyle();
  useActivity(client, style);
  useSeo("/about");
  return (
    <div className="about">
      <Header>
        <StyleSwitch style={style} onChoose={choose} />
        <AboutNavigation />
      </Header>
      <StyleFeedback issue={issue} />
      <main id="discovery-content">
        <section className="about-hero" aria-labelledby="about-hero-title">
          <HeroGallery style={style} />
          <div className="about-hero-copy">
            <p className="about-eyebrow">{about.eyebrow}</p>
            <h1 id="about-hero-title">
              {about.title}
              <span>{about.titleAccent}</span>
            </h1>
            <div className="about-hero-bottom">
              <p className="about-intro">{about.heroIntro}</p>
              <ExploreLink />
            </div>
          </div>
          <a className="about-scroll" href="#about" aria-label={about.about}>
            <span className="icon icon-down" aria-hidden="true" />
          </a>
        </section>
        <p className="about-notice">
          <span aria-hidden="true" />
          {about.waiting}
        </p>

        <section className="about-conversation" id="about" aria-labelledby="about-title">
          <div className="about-conversation-copy">
            <div>
              <p className="about-eyebrow">{about.aboutEyebrow}</p>
              <h2 id="about-title">
                {about.conversationTitle}
                <span>{about.conversationAccent}</span>
              </h2>
            </div>
            <div>
              <p className="about-section-intro">{about.features[1]!.body}</p>
              <p className="about-conversation-note">{about.features[2]!.body}</p>
            </div>
          </div>
          <ConversationScene style={style} />
        </section>

        <AboutHighlights />

        <section className="about-faq" id="faq" aria-labelledby="faq-title">
          <div>
            <p className="about-eyebrow">{about.faq}</p>
            <h2 id="faq-title">{about.faqTitle}</h2>
          </div>
          <div className="about-questions">
            {about.questions.map((question) => (
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

        <section className="about-closing" aria-labelledby="closing-title">
          <div className="about-closing-copy">
            <p className="about-eyebrow">Ren AI</p>
            <h2 id="closing-title">
              {about.closingTitle}
              <span>{about.closingAccent}</span>
            </h2>
            <p>{about.closingBody}</p>
            <ExploreLink />
          </div>
          <figure className="about-closing-photo">
            <img
              src={landingImage("dohee-daily", style)}
              width="928"
              height="1152"
              alt={about.dailyPhoto}
              loading="lazy"
            />
            <figcaption>
              <span className="about-greeting-name">
                <span className="icon icon-message" aria-hidden="true" />
                <span>{about.personaNames.dohee}</span>
                <span>iMessage</span>
              </span>
              <p>{about.greeting}</p>
              <small>{about.exampleNote}</small>
            </figcaption>
          </figure>
        </section>
      </main>
      <footer className="about-footer">
        <div>
          <a className="wordmark" href={localizedPath("/explore", locale)}>
            <img src="/brand.svg" width="30" height="30" alt="" />
            {copy.brand}
          </a>
          <p>{about.footer}</p>
        </div>
        <PrivacyDisclosure />
      </footer>
    </div>
  );
}
