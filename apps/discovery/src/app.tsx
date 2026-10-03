import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import { discoveryClient } from "./client.ts";
import type { DiscoveryClient } from "./client.ts";
import { readChoices, saveChoices } from "./choices.ts";
import { Card } from "./card.tsx";
import { JoinForm } from "./join-form.tsx";
import copy from "./copy.json";
import { readImageStyle, saveImageStyle, withImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import { StylePicker, StyleSwitch } from "./style-picker.tsx";

function SwipeActions({
  current,
  choose,
  disabled,
}: {
  current: PublicPersona | undefined;
  choose: (persona: PublicPersona, like: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="swipe-actions">
      <button
        className="pass-button"
        type="button"
        aria-label={copy.pass}
        onClick={current ? () => choose(current, false) : undefined}
        disabled={disabled}
      >
        <span className="icon icon-pass" aria-hidden="true" />
        <span>{copy.pass}</span>
      </button>
      <button
        className="like-button"
        type="button"
        aria-label={copy.like}
        onClick={current ? () => choose(current, true) : undefined}
        disabled={disabled}
      >
        <span className="icon icon-heart" aria-hidden="true" />
        <span>{copy.like}</span>
      </button>
    </div>
  );
}

function Deck({
  people,
  current,
  likedCount,
  hasPassed,
  choose,
  restart,
}: {
  people: readonly PublicPersona[];
  current: PublicPersona | undefined;
  likedCount: number;
  hasPassed: boolean;
  choose: (persona: PublicPersona, like: boolean) => void;
  restart: () => void;
}) {
  if (!people.length)
    return (
      <div className="empty-card">
        <span className="empty-icon icon icon-cards" aria-hidden="true" />
        <h2>{copy.empty}</h2>
        <p>{copy.emptyHint}</p>
      </div>
    );
  if (current)
    return (
      <div className="card-stack">
        <Card
          key={`${current.id}:${current.imageUrl}`}
          persona={current}
          onChoose={(like) => choose(current, like)}
        />
      </div>
    );
  return (
    <div className="empty-card">
      <span className="empty-icon icon icon-cards" aria-hidden="true" />
      <h2>{copy.end}</h2>
      <p>{likedCount ? copy.endHint : copy.noLikes}</p>
      {hasPassed && (
        <button className="text-button" type="button" onClick={restart}>
          {copy.restart}
        </button>
      )}
    </div>
  );
}

function Receipt({ waiting }: { waiting: boolean }) {
  return (
    <section className="receipt" aria-labelledby="receipt-title">
      <span className="receipt-mark" aria-hidden="true">
        <span className="icon icon-check" />
      </span>
      <h1 id="receipt-title">{waiting ? copy.waitingTitle : copy.activeTitle}</h1>
      <p>{waiting ? copy.waitingMessage : copy.activeMessage}</p>
      {waiting && <p className="receipt-hint">{copy.waitingHint}</p>}
    </section>
  );
}

type Catalog =
  | { phase: "loading" }
  | { phase: "failed" }
  | { phase: "ready"; people: readonly PublicPersona[] };

export function App({ client = discoveryClient }: { client?: DiscoveryClient }) {
  const [catalog, setCatalog] = useState<Catalog>({ phase: "loading" });
  const activeRequest = useRef(new AbortController());
  const load = useCallback(
    (controller: AbortController) => {
      void client
        .profiles(controller.signal)
        .then((people) => {
          if (!controller.signal.aborted) setCatalog({ phase: "ready", people });
          return undefined;
        })
        .catch(() => {
          if (!controller.signal.aborted) setCatalog({ phase: "failed" });
        });
    },
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    activeRequest.current = controller;
    load(controller);
    return () => activeRequest.current.abort();
  }, [load]);
  function retry() {
    const controller = new AbortController();
    activeRequest.current = controller;
    setCatalog({ phase: "loading" });
    load(controller);
  }
  return (
    <div className="discovery-shell">
      <header className="site-header">
        <a className="wordmark" href="/">
          {copy.brand}
        </a>
        <span className="header-channel">{copy.channel}</span>
      </header>
      <main className="discovery-main">
        <div className="experience">
          {catalog.phase === "ready" ? (
            <Experience people={catalog.people} client={client} />
          ) : (
            <section className="browse-panel">
              <div className="empty-card">
                {catalog.phase === "failed" && (
                  <>
                    <h2>{copy.loadFailure}</h2>
                    <button className="primary-button" type="button" onClick={retry}>
                      {copy.retry}
                    </button>
                  </>
                )}
                {catalog.phase === "loading" && <output>{copy.loading}</output>}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function Experience({
  people,
  client,
}: {
  people: readonly PublicPersona[];
  client: DiscoveryClient;
}) {
  const [choices, setChoices] = useState(readChoices);
  const [style, setStyle] = useState(readImageStyle);
  const [styleStorageFailure, setStyleStorageFailure] = useState(false);
  const chosen = useRef(choices);
  const [storageFailure, setStorageFailure] = useState<true>();
  const [view, setView] = useState<"browse" | "contact" | "waiting" | "active">("browse");
  const displayed = style ? people.map((persona) => withImageStyle(persona, style)) : people;
  const current = displayed.find((persona) => !Object.hasOwn(choices, persona.id));
  const liked = displayed.filter((persona) => choices[persona.id] === true);
  function chooseStyle(next: ImageStyle) {
    setStyle(next);
    setStyleStorageFailure(!saveImageStyle(next));
  }
  function choose(persona: PublicPersona, like: boolean) {
    if (Object.hasOwn(chosen.current, persona.id)) return;
    const next = { ...chosen.current, [persona.id]: like };
    chosen.current = next;
    setChoices(next);
    setStorageFailure(saveChoices(next) ? undefined : true);
  }
  function restart() {
    const next = Object.fromEntries(Object.entries(chosen.current).filter(([, like]) => like));
    chosen.current = next;
    setChoices(next);
    setStorageFailure(saveChoices(next) ? undefined : true);
  }
  const sample = people.find((persona) => persona.portraits) ?? people[0];
  if (!style && sample) return <StylePicker sample={sample} onChoose={chooseStyle} />;
  return (
    <>
      {style && <StyleSwitch style={style} onChoose={chooseStyle} />}
      {styleStorageFailure && (
        <output className="storage-warning">{copy.styleStorageFailure}</output>
      )}
      {view === "browse" ? (
        <section className="browse-panel" aria-label={copy.explore}>
          <div className="browse-topline">
            <h1>{copy.explore}</h1>
            <span className="like-count">
              <span className="icon icon-heart" aria-hidden="true" />
              <span className="sr-only">{copy.likeCount} </span>
              {liked.length}
            </span>
          </div>
          <p className="browse-intro">{copy.intro}</p>
          <Deck
            people={people}
            current={current}
            likedCount={liked.length}
            hasPassed={people.some((persona) => choices[persona.id] === false)}
            choose={choose}
            restart={restart}
          />
          <p id="swipe-help" className="sr-only">
            {copy.instructions}
          </p>
          <SwipeActions current={current} choose={choose} disabled={!current} />
          {storageFailure && <output className="storage-warning">{copy.storageFailure}</output>}
          <button
            className="primary-button contact-button"
            type="button"
            disabled={!liked.length}
            onClick={() => setView("contact")}
          >
            {copy.contact}
            <span className="contact-count">{liked.length}</span>
            <span className="icon icon-arrow" aria-hidden="true" />
          </button>
          <p className="browse-hint">{copy.browseHint}</p>
        </section>
      ) : view === "contact" ? (
        <JoinForm
          liked={liked}
          client={client}
          onBack={() => setView("browse")}
          onSuccess={setView}
        />
      ) : (
        <Receipt waiting={view === "waiting"} />
      )}
    </>
  );
}
