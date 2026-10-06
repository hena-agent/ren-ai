import { useEffect, useRef, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import copy from "./copy.json";
import type { StyledPersona } from "./image-style.ts";
import { GalleryControls } from "./photo-gallery.tsx";
import { ProfileDetails } from "./profile-details.tsx";

function PortraitImage({ persona }: { persona: PublicPersona }) {
  const [failed, setFailed] = useState(false);
  return failed || !persona.imageUrl ? (
    <div className="photo-fallback">
      <span>{persona.name.slice(0, 1)}</span>
      <p>{persona.imageUrl ? copy.photoFailure : copy.noStylePhoto}</p>
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
  onCollapse,
  initialImage = 0,
}: {
  persona: StyledPersona;
  next?: PublicPersona | undefined;
  onChoose: (like: boolean) => void;
  onOpen: (persona: PublicPersona, image?: number) => void;
  onBusyChange?: (busy: boolean) => void;
  onCollapse?: (() => void) | undefined;
  initialImage?: number | undefined;
}) {
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const pending = useRef<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [drag, setDrag] = useState(0);
  const [exit, setExit] = useState<"like" | "pass">();
  const [image, setImage] = useState(initialImage);
  const images = persona.imageUrls ?? [persona.imageUrl];
  const currentImage = Math.min(image, images.length - 1);
  const shown = { ...persona, imageUrl: images[currentImage]! };
  function open() {
    if (images.length > 1) onOpen(persona, currentImage);
    else onOpen(persona);
  }
  useEffect(() => {
    if (!onCollapse && document.activeElement === document.body)
      openButton.current!.focus({ preventScroll: true });
  }, [onCollapse]);
  useEffect(() => {
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
    <div className="card-interaction" data-expanded={Boolean(onCollapse)}>
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
          data-gallery={images.length > 1}
          data-expanded={Boolean(onCollapse)}
          style={{ transform: `translateX(${drag}px) rotate(${drag / 24}deg)` }}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === "card-exit")
              finish();
          }}
        >
          {onCollapse ? (
            <ProfileDetails
              persona={persona}
              image={currentImage}
              onImageChange={setImage}
              onClose={onCollapse}
              disabled={exit !== undefined}
            />
          ) : (
            <>
              <div
                className="swipe-surface"
                onPointerDown={(event) => {
                  if (event.button !== 0 || !event.isPrimary) return;
                  pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (pointer.current?.id === event.pointerId) {
                    const offset = event.clientX - pointer.current.x;
                    setDrag(offset);
                  }
                }}
                onPointerCancel={() => {
                  reset();
                }}
                onPointerUp={(event) => {
                  if (pointer.current?.id !== event.pointerId) return;
                  const offset = event.clientX - pointer.current.x;
                  const vertical = event.clientY - pointer.current.y;
                  pointer.current = null;
                  if (offset >= 90 && Math.abs(offset) > Math.abs(vertical)) choose(true);
                  else if (offset <= -90 && Math.abs(offset) > Math.abs(vertical)) choose(false);
                  else setDrag(0);
                }}
              >
                <PortraitImage key={shown.imageUrl} persona={shown} />
              </div>
              <GalleryControls
                count={images.length}
                current={currentImage}
                onChange={setImage}
                disabled={exit !== undefined}
              />
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
                ref={openButton}
                type="button"
                aria-label={`${persona.name} 소개 전체 보기`}
                disabled={exit !== undefined}
                onClick={open}
                aria-describedby="swipe-help"
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    choose(event.key === "ArrowRight");
                  }
                }}
              >
                <span className="icon icon-arrow" aria-hidden="true" />
              </button>
            </>
          )}
        </article>
      </div>
      <SwipeActions disabled={exit !== undefined} onChoose={choose} />
    </div>
  );
}
