import { useState } from "react";
import { useCopy } from "./locale.tsx";

const portraits = [
  { image: "seoyeon", name: "한서연" },
  { image: "seowoo", name: "한서우" },
  { image: "seoyul", name: "강서율" },
];

export function HeroGallery() {
  const copy = useCopy();
  const [selected, setSelected] = useState(1);
  return (
    <div className="hero-gallery">
      <div className="hero-portraits" aria-hidden="true">
        {portraits.map((portrait, index) => (
          <div className="hero-scene" key={portrait.image} data-active={selected === index}>
            <img
              src={`/landing/${portrait.image}.webp`}
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
        {portraits.map((portrait, index) => (
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
