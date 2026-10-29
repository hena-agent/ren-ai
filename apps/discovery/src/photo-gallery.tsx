import { useState } from "react";
import type { MouseEvent } from "react";
import { useCopy } from "./locale.tsx";
import { prefersReducedMotion } from "./motion.ts";

/** The equal-width column, counted from the left, that a click landed in. */
export function tapColumn(event: MouseEvent<HTMLElement>, columns: number) {
  const { left, width } = event.currentTarget.getBoundingClientRect();
  return Math.min(columns - 1, Math.max(0, Math.floor(((event.clientX - left) / width) * columns)));
}

/** Moves one photo along; a step past either end nudges the photo instead of moving. */
export function usePhotoSteps(count: number, current: number, onChange: (index: number) => void) {
  const [nudge, setNudge] = useState<"previous" | "next">();
  function step(direction: number) {
    const target = Math.min(count - 1, Math.max(0, current + direction));
    if (target !== current) onChange(target);
    else if (!prefersReducedMotion()) setNudge(direction < 0 ? "previous" : "next");
  }
  return { nudge, step, endNudge: () => setNudge(undefined) };
}

export function GalleryControls({
  images,
  current,
  disabled = false,
  onChange,
}: {
  images: readonly string[];
  current: number;
  disabled?: boolean;
  onChange: (index: number) => void;
}) {
  const copy = useCopy();
  const count = images.length;
  if (count <= 1) return null;
  return (
    <div className="gallery-controls">
      {images
        .filter((_, index) => Math.abs(index - current) === 1)
        .map((url) => (
          <link key={url} rel="preload" as="image" href={url} fetchPriority="low" />
        ))}
      <div className="gallery-progress" aria-label={copy.photos}>
        {Array.from({ length: count }, (_, index) => (
          <button
            key={index}
            type="button"
            aria-label={`${copy.photo} ${index + 1} / ${count}`}
            aria-current={index === current ? "step" : undefined}
            disabled={disabled}
            onClick={() => onChange(index)}
          >
            <span />
          </button>
        ))}
      </div>
      <button
        className="gallery-zone gallery-previous"
        type="button"
        aria-label={copy.previousPhoto}
        disabled={disabled || current === 0}
        onClick={() => onChange(current - 1)}
      />
      <button
        className="gallery-zone gallery-next"
        type="button"
        aria-label={copy.nextPhoto}
        disabled={disabled || current === count - 1}
        onClick={() => onChange(current + 1)}
      />
      <output className="sr-only" aria-live="polite">
        {current + 1} / {count}
      </output>
    </div>
  );
}
