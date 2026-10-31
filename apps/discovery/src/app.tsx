import { useEffect, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import { discoveryClient } from "./client.ts";
import type { DiscoveryClient } from "./client.ts";
import { readChoices, saveChoices } from "./choices.ts";
import { Card } from "./card.tsx";
import { JoinForm } from "./join-form.tsx";
import { useCopy, useLocale, LocaleProvider } from "./locale.tsx";
import type { Locale } from "./locale.tsx";
import { withImageStyle, readImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import type { StyledPersona } from "./image-style.ts";
import { StyleSwitch, StyleFeedback } from "./style-switch.tsx";
import { useImageStyle } from "./use-image-style.ts";
import { useInputModality } from "./use-input-modality.ts";
import { Header, LikedPanel, Navigation } from "./chrome.tsx";
import type { BrowseView } from "./chrome.tsx";
import { Receipt } from "./receipt.tsx";
import { useCatalog } from "./use-catalog.ts";
import { shareUrl, publicRoute, localizedPath } from "./public-routing.ts";
import { useSeo } from "./use-seo.ts";
import type { SampledPage } from "./public-routing.ts";
import { BrowseLoading, type Paging } from "./browse-loading.tsx";
import { useActivity, useBrowseActivity } from "./activity.ts";

type Entry = {
  personaId?: string | undefined;
  initialStyle?: ImageStyle | undefined;
  initialPeople?: readonly PublicPersona[] | undefined;
  initialPage?: SampledPage | undefined;
  reselectionToken?: string | undefined;
};

function Deck({
  people,
  current,
  next,
  likedCount,
  hasPassed,
  choose,
  restart,
  onNavigate,
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
  onNavigate: (view: BrowseView) => void;
  onOpen: (persona: PublicPersona, image?: number) => void;
  onBusyChange: (busy: boolean) => void;
  details: { persona: StyledPersona; image: number } | undefined;
  onCollapse: () => void;
}) {
  const copy = useCopy();
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
      {likedCount > 0 && (
        <button className="primary-button" type="button" onClick={() => onNavigate("contact")}>
          {copy.contact}
        </button>
      )}
      {hasPassed && (
        <button className="text-button" type="button" onClick={restart}>
          {copy.restart}
        </button>
      )}
    </div>
  );
}

export function App({
  client = discoveryClient,
  initialLocale,
  ...entry
}: Entry & { client?: DiscoveryClient; initialLocale?: Locale | undefined }) {
  return (
    <LocaleProvider initialLocale={initialLocale}>
      <DiscoveryApp client={client} {...entry} />
    </LocaleProvider>
  );
}

function LoadingActivity({
  client,
  initialStyle,
}: {
  client: DiscoveryClient;
  initialStyle: ImageStyle | undefined;
}) {
  useActivity(client, initialStyle ?? readImageStyle(), true);
  useSeo();
  return null;
}

function DiscoveryApp({
  client,
  initialPeople,
  initialPage,
  personaId,
  initialStyle,
  reselectionToken,
}: Entry & { client: DiscoveryClient }) {
  const copy = useCopy();
  const { locale } = useLocale();
  const { catalog, retry, refresh, ...paging } = useCatalog(
    client,
    initialPeople,
    reselectionToken,
    personaId,
    initialPage,
  );
  const [reviewingSelection, setReviewingSelection] = useState(false);
  const requested =
    catalog.phase === "ready" && catalog.people.find((person) => person.id === personaId);
  const missing =
    catalog.phase === "ready" && Boolean(personaId) && !requested && !reviewingSelection;
  useEffect(() => {
    if (missing) document.title = `${copy.publicProfile.notFound} — RenAI`;
  }, [missing, copy.publicProfile.notFound]);
  return (
    <div className="discovery-shell">
      {(catalog.phase !== "ready" || missing) && (
        <LoadingActivity client={client} initialStyle={initialStyle} />
      )}
      {catalog.phase === "ready" ? (
        missing ? (
          <>
            <Header />
            <main className="onboarding-view" id="discovery-content">
              <div className="empty-card">
                <h1>{copy.publicProfile.notFound}</h1>
                <p>{copy.publicProfile.notFoundHint}</p>
                <a
                  href={
                    reselectionToken === undefined
                      ? localizedPath("/explore", locale)
                      : `${localizedPath("/explore", locale)}#reselect=${encodeURIComponent(reselectionToken)}`
                  }
                >
                  {copy.back}
                </a>
              </div>
            </main>
          </>
        ) : (
          <Experience
            people={catalog.people}
            client={client}
            personaId={personaId}
            initialStyle={initialStyle}
            paging={paging}
            onRefresh={() => {
              setReviewingSelection(true);
              return refresh();
            }}
          />
        )
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

function useBrowseView() {
  const [view, setView] = useState<BrowseView | "waiting" | "active">("browse");
  const [contactOpened, setContactOpened] = useState(false);
  function navigate(next: BrowseView) {
    if (next === "contact") setContactOpened(true);
    setView(next);
  }
  function back() {
    setView("browse");
  }
  return { view, setView, contactOpened, navigate, back };
}

function prioritizePersona(people: readonly PublicPersona[], personaId: string | undefined) {
  return [
    ...people.filter((person) => person.id === personaId),
    ...people.filter((person) => person.id !== personaId),
  ];
}

function useProfileDetails(personaId: string | undefined) {
  const { locale } = useLocale();
  const [details, setDetails] = useState<{ id: string; image: number } | undefined>(() =>
    personaId ? { id: personaId, image: 0 } : undefined,
  );
  const openDetails = (persona: PublicPersona, image = 0) => setDetails({ id: persona.id, image });
  const closeDetails = () => {
    setDetails(undefined);
    if (publicRoute(new URL(window.location.href)).id)
      window.history.replaceState(
        window.history.state,
        "",
        `${localizedPath("/explore", locale)}${window.location.hash}`,
      );
  };
  return { details, openDetails, closeDetails };
}

function Experience({
  people,
  client,
  personaId,
  initialStyle,
  onRefresh,
  paging,
}: {
  people: readonly PublicPersona[];
  client: DiscoveryClient;
  personaId: string | undefined;
  initialStyle: ImageStyle | undefined;
  onRefresh: () => Promise<void>;
  paging: Paging;
}) {
  const copy = useCopy();
  const { locale } = useLocale();
  const [choices, setChoices] = useState(readChoices);
  const { style, issue, choose: changeStyle } = useImageStyle(initialStyle);
  const [storageFailure, setStorageFailure] = useState<true>();
  const { view, setView, contactOpened, navigate, back } = useBrowseView();
  const [busy, setBusy] = useState(false);
  const { details, openDetails, closeDetails } = useProfileDetails(personaId);
  useInputModality();
  const ordered = prioritizePersona(people, personaId);
  const displayed = ordered.map((persona) => withImageStyle(persona, style));
  const remaining = displayed.filter((persona) => !Object.hasOwn(choices, persona.id));
  const current = remaining[0];
  const liked = displayed.filter((persona) => choices[persona.id] === true);
  const detail = displayed.find((persona) => persona.id === details?.id);
  const detailId = detail?.id;
  const report = useBrowseActivity(client, style, current?.id, detailId, view);
  useSeo("/explore", detail, style);
  useEffect(() => {
    if (detailId) {
      const target = new URL(shareUrl(detailId, style, locale));
      window.history.replaceState(
        window.history.state,
        "",
        `${target.pathname}${target.search}${window.location.hash}`,
      );
    }
  }, [detailId, style, locale]);
  function choose(persona: PublicPersona, like: boolean) {
    report(like ? "like" : "pass", persona.id);
    const next = { ...choices, [persona.id]: like };
    setChoices(next);
    setStorageFailure(saveChoices(next) ? undefined : true);
  }
  function restart() {
    const next = Object.fromEntries(Object.entries(choices).filter(([, like]) => like));
    setChoices(next);
    setStorageFailure(saveChoices(next) ? undefined : true);
  }
  const header = (
    <>
      <Header>
        <StyleSwitch style={style} onChoose={changeStyle} disabled={busy} />
      </Header>
      <StyleFeedback issue={issue} />
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
          <h1 className="sr-only">{detail ? `${detail.name} — RenAI` : copy.explore}</h1>
          {contactOpened && (
            <div className="contact-surface" hidden={view !== "contact" || Boolean(detail)}>
              <JoinForm
                liked={liked}
                imageStyle={style}
                client={client}
                onBack={back}
                onSuccess={setView}
                onBusyChange={setBusy}
                onRefresh={async () => {
                  await onRefresh();
                  closeDetails();
                }}
              />
            </div>
          )}
          <div className="browse-panel" hidden={view === "contact" && !detail}>
            <BrowseLoading remaining={remaining.length} expanded={Boolean(detail)} paging={paging}>
              <Deck
                people={displayed}
                current={current}
                next={remaining[1]}
                likedCount={liked.length}
                hasPassed={people.some((persona) => choices[persona.id] === false)}
                choose={choose}
                restart={restart}
                onNavigate={navigate}
                onOpen={openDetails}
                onBusyChange={setBusy}
                details={detail && { persona: detail, image: details!.image }}
                onCollapse={closeDetails}
              />
            </BrowseLoading>
            <p id="swipe-help" className="sr-only">
              {copy.instructions}
            </p>
            {storageFailure && <output className="storage-warning">{copy.storageFailure}</output>}
          </div>
        </section>
        <Navigation
          view={view}
          likedCount={liked.length}
          disabled={busy}
          onView={(next) => {
            closeDetails();
            navigate(next);
          }}
        />
      </main>
    </>
  );
}
