import type { PublicPersona } from "@ren-ai/onboarding";
import { withImageStyle } from "./image-style.ts";
import type { ImageStyle } from "./image-style.ts";
import copy from "./copy.json";

export function StylePicker({
  sample,
  onChoose,
}: {
  sample: PublicPersona;
  onChoose: (style: ImageStyle) => void;
}) {
  return (
    <section className="style-picker" aria-labelledby="style-title">
      <h1 id="style-title">{copy.styleTitle}</h1>
      <p>{copy.styleIntro}</p>
      <div className="style-previews">
        <button type="button" onClick={() => onChoose("anime")}>
          <img src={withImageStyle(sample, "anime").imageUrl} alt="" />
          <strong>{copy.animeStyle}</strong>
          <span>{copy.animeStyleHint}</span>
        </button>
        <button type="button" onClick={() => onChoose("photo")}>
          <img src={withImageStyle(sample, "photo").imageUrl} alt="" />
          <strong>{copy.photoStyle}</strong>
          <span>{copy.photoStyleHint}</span>
        </button>
      </div>
      <p className="style-picker-hint">{copy.styleChangeHint}</p>
    </section>
  );
}

export function StyleSwitch({
  style,
  onChoose,
}: {
  style: ImageStyle;
  onChoose: (style: ImageStyle) => void;
}) {
  return (
    <fieldset className="style-switch">
      <legend className="sr-only">{copy.styleSetting}</legend>
      <span aria-hidden="true">{copy.styleSetting}</span>
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
