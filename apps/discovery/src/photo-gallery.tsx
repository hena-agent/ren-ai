import copy from "./copy.json";

export function GalleryControls({
  count,
  current,
  disabled = false,
  onChange,
}: {
  count: number;
  current: number;
  disabled?: boolean;
  onChange: (index: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <div className="gallery-controls">
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
        className="gallery-previous"
        type="button"
        aria-label={copy.previousPhoto}
        disabled={disabled || current === 0}
        onClick={() => onChange(current - 1)}
      >
        <span className="icon icon-arrow" aria-hidden="true" />
      </button>
      <button
        className="gallery-next"
        type="button"
        aria-label={copy.nextPhoto}
        disabled={disabled || current === count - 1}
        onClick={() => onChange(current + 1)}
      >
        <span className="icon icon-arrow" aria-hidden="true" />
      </button>
      <output className="gallery-position" aria-live="polite">
        {current + 1} / {count}
      </output>
    </div>
  );
}
