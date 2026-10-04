import type { ReactNode } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import copy from "./copy.json";

export type BrowseView = "browse" | "liked" | "contact";

export function Header({ children }: { children?: ReactNode }) {
  return (
    <header className="site-header">
      <a className="skip-link" href="#discovery-content">
        {copy.skip}
      </a>
      <a className="wordmark" href="/">
        {copy.brand}
      </a>
      {children}
    </header>
  );
}

export function LikedPanel({
  people,
  onOpen,
}: {
  people: readonly PublicPersona[];
  onOpen: (persona: PublicPersona) => void;
}) {
  return (
    <aside className="discovery-sidebar" aria-labelledby="liked-title">
      <div className="sidebar-heading">
        <span className="sidebar-eyebrow">{copy.yourChoices}</span>
        <h2 id="liked-title">
          {copy.likedTitle} <span>{people.length}</span>
        </h2>
        <p>{copy.likedHint}</p>
      </div>
      {people.length ? (
        <ul className="liked-grid" aria-label={copy.likedTitle}>
          {people.map((persona) => (
            <li key={persona.id}>
              <button
                type="button"
                onClick={() => onOpen(persona)}
                aria-label={`${persona.name} ${copy.details}`}
              >
                <img src={persona.imageUrl} alt="" />
                <span>{persona.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="liked-empty">
          <span className="icon icon-heart" aria-hidden="true" />
          <h3>{copy.likedEmpty}</h3>
          <p>{copy.likedEmptyHint}</p>
        </div>
      )}
      <p className="sidebar-note">{copy.joinIntro}</p>
    </aside>
  );
}

export function Navigation({
  view,
  likedCount,
  disabled,
  onView,
}: {
  view: BrowseView;
  likedCount: number;
  disabled: boolean;
  onView: (view: BrowseView) => void;
}) {
  return (
    <nav className="app-navigation" aria-label={copy.navigation}>
      <button
        className="nav-explore"
        type="button"
        aria-current={view === "browse" ? "page" : undefined}
        disabled={disabled}
        onClick={() => onView("browse")}
      >
        <span className="icon icon-cards" aria-hidden="true" />
        <span>{copy.browseTab}</span>
      </button>
      <button
        className="nav-liked"
        type="button"
        aria-label={`${copy.likedTitle} ${likedCount}`}
        aria-current={view === "liked" ? "page" : undefined}
        disabled={disabled}
        onClick={() => onView("liked")}
      >
        <span className="icon icon-heart" aria-hidden="true" />
        <span>
          {copy.likedTab} <b>{likedCount}</b>
        </span>
      </button>
      <button
        className="contact-button"
        type="button"
        aria-current={view === "contact" ? "page" : undefined}
        disabled={disabled || !likedCount}
        onClick={() => onView("contact")}
      >
        <span className="icon icon-arrow" aria-hidden="true" />
        <span>{copy.contact}</span>
        <span className="contact-count">{likedCount}</span>
      </button>
    </nav>
  );
}
