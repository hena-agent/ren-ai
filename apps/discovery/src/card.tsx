import { useEffect, useRef, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import copy from "./copy.json";

function PortraitImage({ persona }: { persona: PublicPersona }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <div className="photo-fallback">
      <span>{persona.name.slice(0, 1)}</span>
      <p>{copy.photoFailure}</p>
    </div>
  ) : (
    <img
      className="profile-photo"
      src={persona.imageUrl}
      alt={`${persona.name} 프로필`}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function SwipeActions({
  disabled,
  onChoose,
}: {
  disabled: boolean;
  onChoose: (like: boolean) => void;
}) {
  return (
    <div className="swipe-actions">
      <button
        className="pass-button"
        type="button"
        aria-label={copy.pass}
        title={copy.pass}
        disabled={disabled}
        onClick={() => onChoose(false)}
      >
        <span className="icon icon-pass" aria-hidden="true" />
      </button>
      <button
        className="like-button"
        type="button"
        aria-label={copy.like}
        title={copy.like}
        disabled={disabled}
        onClick={() => onChoose(true)}
      >
        <span className="icon icon-heart" aria-hidden="true" />
      </button>
    </div>
  );
}

export function Card({
  persona,
  next,
  onChoose,
  onOpen,
  onBusyChange,
}: {
  persona: PublicPersona;
  next?: PublicPersona | undefined;
  onChoose: (like: boolean) => void;
  onOpen: (persona: PublicPersona) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const surface = useRef<HTMLButtonElement>(null);
  const dragged = useRef(false);
  const pending = useRef<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [drag, setDrag] = useState(0);
  const [exit, setExit] = useState<"like" | "pass">();
  useEffect(() => {
    if (document.activeElement === document.body) surface.current!.focus({ preventScroll: true });
    return () => {
      clearTimeout(timer.current);
      onBusyChange?.(false);
    };
  }, [onBusyChange]);
  function finish() {
    const choice = pending.current;
    if (choice === null) return;
    pending.current = null;
    clearTimeout(timer.current);
    setExit(undefined);
    onBusyChange?.(false);
    onChoose(choice);
  }
  function choose(like: boolean) {
    if (pending.current !== null) return;
    pending.current = like;
    pointer.current = null;
    onBusyChange?.(true);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDrag(0);
      finish();
    } else {
      setExit(like ? "like" : "pass");
      // A hidden tab or interrupted CSS animation must still complete the user's choice.
      timer.current = setTimeout(finish, 400);
    }
  }
  function reset() {
    pointer.current = null;
    setDrag(0);
  }
  return (
    <div className="card-interaction">
      <div className="card-media">
        {next && (
          <div className="card-back" aria-hidden="true">
            <img src={next.imageUrl} alt="" draggable={false} />
          </div>
        )}
        <article
          className="profile-card"
          data-exit={exit}
          data-dragging={drag !== 0}
          aria-busy={exit !== undefined}
          style={{ transform: `translateX(${drag}px) rotate(${drag / 24}deg)` }}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === "card-exit")
              finish();
          }}
        >
          <button
            className="swipe-surface"
            ref={surface}
            type="button"
            aria-label={`${persona.name} ${copy.details}`}
            aria-describedby="swipe-help"
            disabled={exit !== undefined}
            onClick={(event) => {
              if (event.detail === 0 || !dragged.current) onOpen(persona);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                choose(event.key === "ArrowRight");
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              dragged.current = false;
              pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (pointer.current?.id === event.pointerId) {
                const offset = event.clientX - pointer.current.x;
                dragged.current ||=
                  Math.abs(offset) > 6 || Math.abs(event.clientY - pointer.current.y) > 6;
                setDrag(offset);
              }
            }}
            onPointerCancel={() => {
              dragged.current = true;
              reset();
            }}
            onPointerUp={(event) => {
              if (pointer.current?.id !== event.pointerId) return;
              const offset = event.clientX - pointer.current.x;
              const vertical = event.clientY - pointer.current.y;
              dragged.current ||= Math.abs(offset) > 6 || Math.abs(vertical) > 6;
              pointer.current = null;
              if (offset >= 90 && Math.abs(offset) > Math.abs(vertical)) choose(true);
              else if (offset <= -90 && Math.abs(offset) > Math.abs(vertical)) choose(false);
              else setDrag(0);
            }}
          >
            <PortraitImage key={persona.imageUrl} persona={persona} />
          </button>
          <span className="profile-label">{copy.profileLabel}</span>
          {(drag > 24 || exit === "like") && (
            <span className="swipe-stamp like-stamp" aria-hidden="true">
              LIKE
            </span>
          )}
          {(drag < -24 || exit === "pass") && (
            <span className="swipe-stamp pass-stamp" aria-hidden="true">
              PASS
            </span>
          )}
          <div className="profile-caption">
            <h2>{persona.name}</h2>
            <p>{persona.bio}</p>
          </div>
          <button
            className="profile-info"
            type="button"
            aria-label={`${persona.name} 소개 전체 보기`}
            disabled={exit !== undefined}
            onClick={() => onOpen(persona)}
          >
            <span className="icon icon-info" aria-hidden="true" />
          </button>
        </article>
      </div>
      <SwipeActions disabled={exit !== undefined} onChoose={choose} />
    </div>
  );
}
