import { useRef, useState } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import copy from "./copy.json";

export function Card({
  persona,
  onChoose,
}: {
  persona: PublicPersona;
  onChoose: (like: boolean) => void;
}) {
  const pointer = useRef<{ id: number; x: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const [failedPhoto, setFailedPhoto] = useState(false);
  const reset = () => {
    pointer.current = null;
    setDrag(0);
  };
  return (
    <article
      className="profile-card"
      style={{ transform: `translateX(${drag}px) rotate(${drag / 24}deg)` }}
    >
      <button
        className="swipe-surface"
        type="button"
        aria-label={`${persona.name} 프로필 카드 좋아요`}
        aria-describedby="swipe-help"
        onClick={() => onChoose(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            onChoose(event.key === "ArrowRight");
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          pointer.current = { id: event.pointerId, x: event.clientX };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointer.current?.id === event.pointerId) setDrag(event.clientX - pointer.current.x);
        }}
        onPointerCancel={reset}
        onPointerUp={(event) => {
          if (pointer.current?.id !== event.pointerId) return;
          const offset = event.clientX - pointer.current.x;
          reset();
          if (offset >= 90) onChoose(true);
          else if (offset <= -90) onChoose(false);
        }}
      >
        {failedPhoto ? (
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
            onError={() => setFailedPhoto(true)}
          />
        )}
      </button>
      <span className="profile-label">{copy.profileLabel}</span>
      {drag > 24 && (
        <span className="swipe-stamp like-stamp" aria-hidden="true">
          LIKE
        </span>
      )}
      {drag < -24 && (
        <span className="swipe-stamp pass-stamp" aria-hidden="true">
          PASS
        </span>
      )}
      <div className="profile-caption">
        <h2>{persona.name}</h2>
        <p>{persona.bio}</p>
      </div>
    </article>
  );
}
