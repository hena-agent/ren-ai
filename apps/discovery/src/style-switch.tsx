import type { ImageStyle } from "./image-style.ts";
import { useCopy } from "./locale.tsx";
import type { StyleIssue } from "./use-image-style.ts";

export function StyleSwitch({
  style,
  onChoose,
  changing,
  disabled = false,
}: {
  style: ImageStyle;
  onChoose: (style: ImageStyle) => void;
  changing: boolean;
  disabled?: boolean;
}) {
  const copy = useCopy();
  function select(next: ImageStyle) {
    if (!changing) onChoose(next);
  }
  return (
    <fieldset
      className="style-switch"
      disabled={disabled}
      aria-disabled={disabled || changing}
      aria-busy={changing}
    >
      <legend className="sr-only">{copy.styleSetting}</legend>
      <div>
        <button type="button" aria-pressed={style === "anime"} onClick={() => select("anime")}>
          {copy.animeStyle}
        </button>
        <button type="button" aria-pressed={style === "photo"} onClick={() => select("photo")}>
          {copy.photoStyle}
        </button>
      </div>
      {changing && <output className="sr-only">{copy.styleUpdating}</output>}
    </fieldset>
  );
}

export function StyleFeedback({ issue }: { issue: StyleIssue }) {
  const copy = useCopy();
  if (!issue) return null;
  return (
    <output className="style-feedback" role="alert">
      {issue === "load" ? copy.styleLoadFailure : copy.styleStorageFailure}
    </output>
  );
}
