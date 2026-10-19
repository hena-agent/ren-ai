import { Fragment } from "react";
import type { ReactNode } from "react";
import { useCopy } from "./locale.tsx";
import { landingImage } from "./landing-images.ts";
import type { ImageStyle } from "./image-style.ts";

function Message({
  direction,
  media = false,
  children,
}: {
  direction: "incoming" | "outgoing";
  media?: boolean;
  children: ReactNode;
}) {
  return (
    <li className="conversation-message" data-direction={direction}>
      <div className="conversation-reveal">
        <div className={`conversation-bubble${media ? " conversation-media" : ""}`}>{children}</div>
      </div>
    </li>
  );
}

export function ConversationScene({ style }: { style: ImageStyle }) {
  const copy = useCopy();
  const daily = landingImage("dohee-daily", style);
  return (
    <figure className="conversation-demo" aria-label={copy.home.exampleLabel}>
      <div className="conversation-story">
        <div className="conversation-viewport">
          <div className="conversation-photo" aria-hidden="true">
            <img src={daily} width="928" height="1152" alt="" loading="lazy" />
          </div>
          <div className="conversation-thread">
            <div className="conversation-contact">
              <img
                src={landingImage("dohee", style)}
                width="44"
                height="44"
                alt=""
                loading="lazy"
              />
              <div>
                <strong lang="ko">백도희</strong>
                <span>{copy.home.personaLabel}</span>
              </div>
              <span className="conversation-platform">iMessage</span>
            </div>
            <div className="conversation-window">
              <ol className="conversation-messages">
                {copy.home.exchanges.map((scene, index) => (
                  <Fragment key={scene.message}>
                    <Message media direction={index === 1 ? "outgoing" : "incoming"}>
                      {index === 2 ? (
                        <a
                          className="conversation-music"
                          aria-label={`Best Part (feat. H.E.R.) — Daniel Caesar. ${copy.home.openMusic}`}
                          href="https://open.spotify.com/track/1RMJOxR6GRPsBHL8qeC2ux"
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span className="conversation-music-icon">
                            <span className="icon icon-music" aria-hidden="true" />
                          </span>
                          <span>
                            <strong>Best Part (feat. H.E.R.)</strong>
                            <span>Daniel Caesar</span>
                            <small>
                              {copy.home.openMusic}
                              <span className="icon icon-external" aria-hidden="true" />
                            </small>
                          </span>
                        </a>
                      ) : (
                        <>
                          <img
                            src={index === 1 ? "/landing/cafe.webp" : daily}
                            width="400"
                            height={index === 1 ? "267" : "497"}
                            alt={index === 1 ? copy.home.cafePhoto : copy.home.dailyPhoto}
                            loading="lazy"
                          />
                          {index === 1 && (
                            <span className="conversation-reaction">
                              <span className="icon icon-heart" aria-hidden="true" />
                              <span className="sr-only">{copy.home.heartReaction}</span>
                            </span>
                          )}
                        </>
                      )}
                    </Message>
                    <Message direction="incoming">
                      <p>{scene.message}</p>
                    </Message>
                    <Message direction="outgoing">
                      <p>{scene.reply}</p>
                    </Message>
                  </Fragment>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="conversation-note">{copy.home.exampleNote}</figcaption>
    </figure>
  );
}
