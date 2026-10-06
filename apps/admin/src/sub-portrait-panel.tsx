import type { PersonaRecord } from "@ren-ai/personas";
import { personaImages } from "@ren-ai/personas";
import copy from "./copy.json";

export function SubPortraitPanel({
  persona,
  action,
  reservations = { anime: 0, photo: 0 },
}: {
  persona: PersonaRecord;
  action: string;
  reservations?: { anime: number; photo: number } | undefined;
}) {
  return (
    <fieldset className="sub-portraits">
      <legend>{copy.additionalImages}</legend>
      <p className="hint">{copy.additionalImagesHint}</p>
      <div className="generation-actions">
        {(["anime", "photo"] as const).map((style) => {
          const remaining =
            6 -
            personaImages(persona).filter((image) => image.style === style).length -
            reservations[style];
          return (
            <button
              key={style}
              data-source-bound
              type="submit"
              name="intent"
              value="subportrait"
              formAction={`${action}?style=${style}`}
              data-portrait-operation={`subportrait:${style}`}
              data-portrait-style={style}
              data-portrait-label={copy.styles[style]}
              data-image-maximum={remaining}
              disabled={remaining <= 0}
            >
              {copy.addImage} · {copy.portraitLabels[style]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
