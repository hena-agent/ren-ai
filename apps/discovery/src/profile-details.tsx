import { useEffect, useRef } from "react";
import type { PublicPersona } from "@ren-ai/onboarding";
import copy from "./copy.json";

export function ProfileDetails({
  persona,
  onClose,
}: {
  persona: PublicPersona;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus({ preventScroll: true });
    };
  });
  return (
    <dialog
      className="profile-details"
      ref={ref}
      aria-labelledby="details-title"
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          close.current!.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        className="details-close"
        ref={close}
        type="button"
        aria-label={copy.closeDetails}
        onClick={onClose}
      >
        <span className="icon icon-pass" aria-hidden="true" />
      </button>
      <img className="details-photo" src={persona.imageUrl} alt={`${persona.name} 프로필`} />
      <div className="details-content">
        <span className="details-label">{copy.profileLabel}</span>
        <h2 id="details-title">{persona.name}</h2>
        <p>{persona.bio}</p>
      </div>
    </dialog>
  );
}
