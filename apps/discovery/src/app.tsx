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
import type { StyledPersona } from "./image-style.ts";
import { StylePicker, StyleSwitch } from "./style-picker.tsx";
import { Header, LikedPanel, Navigation } from "./chrome.tsx";
import type { BrowseView } from "./chrome.tsx";

function Deck({
  people,
  current,
  next,
  likedCount,
  hasPassed,
  choose,
  restart,
  onOpen,
  onBusyChange,
  details,
  onCollapse,
}: {
  people: readonly StyledPersona[];
  current: StyledPersona | undefined;
  next: PublicPersona | undefined;
  likedCount: number;
  hasPassed: boolean;
  choose: (persona: PublicPersona, like: boolean) => void;
  restart: () => void;
  onOpen: (persona: PublicPersona, image?: number) => void;
  onBusyChange: (busy: boolean) => void;
  details: { persona: StyledPersona; image: number } | undefined;
  onCollapse: () => void;
}) {
  if (!people.length)
    return (
      <div className="empty-card">
        <span className="empty-icon icon icon-cards" aria-hidden="true" />
        <h2>{copy.empty}</h2>
        <p>{copy.emptyHint}</p>
      </div>
    );
  if (current || details)
    return (
      <>
        {details && details.persona.id !== current?.id && (
          <div className="deck">
            <Card
              key={details.persona.id}
              persona={details.persona}
              initialImage={details.image}
              onChoose={(like) => {
                choose(details.persona, like);
                onCollapse();
              }}
              onOpen={onOpen}
              onCollapse={onCollapse}
              onBusyChange={onBusyChange}
            />
          </div>
        )}
        {current && (
          <div className="deck" hidden={Boolean(details && details.persona.id !== current.id)}>
            <Card
              key={current.id}
              persona={current}
              next={next}
              onChoose={(like) => {
                choose(current, like);
                onCollapse();
              }}
              onOpen={onOpen}
              onBusyChange={onBusyChange}
              onCollapse={details?.persona.id === current.id ? onCollapse : undefined}
            />
          </div>
        )}
      </>
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
      {catalog.phase === "ready" ? (
        <Experience people={catalog.people} client={client} />
      ) : (
        <>
          <Header />
          <main className="onboarding-view" id="discovery-content">
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
          </main>
        </>
      )}
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
  const [storageFailure, setStorageFailure] = useState<true>();
  const [view, setView] = useState<BrowseView | "waiting" | "active">("browse");
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<{ id: string; image: number }>();
  const displayed = style ? people.map((persona) => withImageStyle(persona, style)) : people;
  const remaining = displayed.filter((persona) => !Object.hasOwn(choices, persona.id));
  const current = remaining[0];
  const liked = displayed.filter((persona) => choices[persona.id] === true);
  const detail = displayed.find((persona) => persona.id === details?.id);
  const openDetails = (persona: PublicPersona, image = 0) => setDetails({ id: persona.id, image });
  const closeDetails = () => setDetails(undefined);
  function chooseStyle(next: ImageStyle) {
    setStyle(next);
    setStyleStorageFailure(!saveImageStyle(next));
  }
  function choose(persona: PublicPersona, like: boolean) {
    const next = { ...choices, [persona.id]: like };
    setChoices(next);
    setStorageFailure(saveChoices(next) ? undefined : true);
  }
  function restart() {
    const next = Object.fromEntries(Object.entries(choices).filter(([, like]) => like));
    setChoices(next);
    setStorageFailure(saveChoices(next) ? undefined : true);
  }
  const sample = people.find((persona) => persona.portraits) ?? people[0];
  if (!style && sample)
    return (
      <>
        <Header />
        <main className="onboarding-view" id="discovery-content">
          <StylePicker sample={sample} onChoose={chooseStyle} />
        </main>
      </>
    );
  const header = (
    <>
      <Header>{style && <StyleSwitch style={style} onChoose={chooseStyle} />}</Header>
      {styleStorageFailure && (
        <output className="storage-warning">{copy.styleStorageFailure}</output>
      )}
    </>
  );
  if (view === "waiting" || view === "active")
    return (
      <>
        {header}
        <main className="onboarding-view" id="discovery-content">
          <Receipt waiting={view === "waiting"} />
        </main>
      </>
    );
  return (
    <>
      {header}
      <main
        className="app-workspace"
        id="discovery-content"
        data-view={view}
        data-detail={Boolean(detail)}
      >
        <LikedPanel people={liked} onOpen={openDetails} disabled={busy} />
        <section className="swipe-stage" aria-label={copy.explore}>
          <h1 className="sr-only">{copy.explore}</h1>
          {view === "contact" && (
            <div className="contact-surface" hidden={Boolean(detail)}>
              <JoinForm
                liked={liked}
                client={client}
                onBack={() => setView("browse")}
                onSuccess={setView}
                onBusyChange={setBusy}
              />
            </div>
          )}
          {(view !== "contact" || detail) && (
            <div className="browse-panel">
              <Deck
                people={displayed}
                current={current}
                next={remaining[1]}
                likedCount={liked.length}
                hasPassed={people.some((persona) => choices[persona.id] === false)}
                choose={choose}
                restart={restart}
                onOpen={openDetails}
                onBusyChange={setBusy}
                details={detail && { persona: detail, image: details!.image }}
                onCollapse={closeDetails}
              />
              <p id="swipe-help" className="sr-only">
                {copy.instructions}
              </p>
              {storageFailure && <output className="storage-warning">{copy.storageFailure}</output>}
            </div>
          )}
        </section>
        <Navigation
          view={view}
          likedCount={liked.length}
          disabled={busy}
          onView={(next) => {
            closeDetails();
            setView(next);
          }}
        />
      </main>
    </>
  );
}
