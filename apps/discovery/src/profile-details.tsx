import { useEffect, useEffectEvent, useRef } from "react";
import type { StyledPersona } from "./image-style.ts";
import { GalleryControls } from "./photo-gallery.tsx";
import copy from "./copy.json";

function DetailsGallery({
  persona,
  image,
  onImageChange,
  disabled,
}: {
  persona: StyledPersona;
  image: number;
  onImageChange: (image: number) => void;
  disabled: boolean;
}) {
  const images = persona.imageUrls ?? [persona.imageUrl];
  const currentImage = Math.min(image, images.length - 1);
  return (
    <div className="details-media">
      {images[currentImage] ? (
        <img className="details-photo" src={images[currentImage]} alt={`${persona.name} 프로필`} />
      ) : (
        <div className="photo-fallback">
          <span>{persona.name.slice(0, 1)}</span>
          <p>{copy.noStylePhoto}</p>
        </div>
      )}
      <GalleryControls
        count={images.length}
        current={currentImage}
        onChange={onImageChange}
        disabled={disabled}
      />
    </div>
  );
}

export function ProfileDetails({
  persona,
  onClose,
  image,
  onImageChange,
  disabled,
}: {
  persona: StyledPersona;
  onClose: () => void;
  image: number;
  onImageChange: (image: number) => void;
  disabled: boolean;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const collapse = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    close.current!.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (!disabled && event.key === "Escape") {
        event.preventDefault();
        collapse();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus({ preventScroll: true });
    };
  }, [disabled]);
  return (
    <section className="profile-details" aria-labelledby="details-title">
      <div className="details-toolbar">
        <h2 id="details-title">{persona.name}</h2>
        <button
          className="details-close"
          ref={close}
          type="button"
          aria-label={copy.closeDetails}
          disabled={disabled}
          onClick={onClose}
        >
          <span className="icon icon-arrow" aria-hidden="true" />
        </button>
      </div>
      <div className="details-scroll">
        <DetailsGallery
          persona={persona}
          image={image}
          onImageChange={onImageChange}
          disabled={disabled}
        />
        <div className="details-content">
          <span className="details-label">{copy.profileLabel}</span>
          <h3>{copy.introductionTitle}</h3>
          <p>{persona.bio}</p>
        </div>
      </div>
    </section>
  );
}
