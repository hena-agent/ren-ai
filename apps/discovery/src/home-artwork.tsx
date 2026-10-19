import { useState } from "react";
import { useCopy } from "./locale.tsx";
import { landingImage, landingPersonas } from "./landing-images.ts";
import type { ImageStyle } from "./image-style.ts";

export function HeroGallery({ style }: { style: ImageStyle }) {
  const copy = useCopy();
  const [selected, setSelected] = useState(1);
  return (
    <div className="hero-gallery">
      <div className="hero-portraits" aria-hidden="true">
        {landingPersonas.map((portrait, index) => (
          <div className="hero-scene" key={portrait.image} data-active={selected === index}>
            <img
              src={landingImage(portrait.image, style)}
              width="720"
              height="894"
              alt=""
              fetchPriority="high"
            />
          </div>
        ))}
      </div>
      <fieldset className="hero-gallery-controls">
        <legend className="sr-only">{copy.home.profileNote}</legend>
        {landingPersonas.map((portrait, index) => (
          <button
            type="button"
            key={portrait.image}
            aria-label={`${portrait.name} ${copy.profilePhoto}`}
            aria-pressed={selected === index}
            onClick={() => setSelected(index)}
          >
            <span lang="ko">{portrait.name}</span>
            <span className="hero-selector-dot" aria-hidden="true" />
          </button>
        ))}
      </fieldset>
    </div>
  );
}
