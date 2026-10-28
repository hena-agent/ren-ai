import type { ImageStyle } from "./image-style.ts";
import { useCopy } from "./locale.tsx";
import type { StyleIssue } from "./use-image-style.ts";

export function StyleSwitch({
  style,
  onChoose,
  disabled = false,
}: {
  style: ImageStyle;
  onChoose: (style: ImageStyle) => void;
  disabled?: boolean;
}) {
  const copy = useCopy();
  return (
    <fieldset className="style-switch" disabled={disabled}>
      <legend className="sr-only">{copy.styleSetting}</legend>
      <div>
        <button type="button" aria-pressed={style === "anime"} onClick={() => onChoose("anime")}>
          {copy.animeStyle}
        </button>
        <button type="button" aria-pressed={style === "photo"} onClick={() => onChoose("photo")}>
          {copy.photoStyle}
        </button>
      </div>
    </fieldset>
  );
}

export function StyleFeedback({ issue }: { issue: StyleIssue }) {
  const copy = useCopy();
  if (!issue) return null;
  return (
    <output className="style-feedback" role="alert">
      {copy.styleStorageFailure}
    </output>
  );
}
