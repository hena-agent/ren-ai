import type { PersonaRecord } from "@ren-ai/personas";
import { personaImages } from "@ren-ai/personas";
import copy from "./copy.json";

export function SubPortraitPanel({
  persona,
  action,
  style,
  reserved,
}: {
  persona: PersonaRecord;
  action: string;
  style: "anime" | "photo";
  reserved: number;
}) {
  const count = personaImages(persona).filter((image) => image.style === style).length;
  const remaining = 6 - count - reserved;
  return (
    <div className="sub-portraits" data-add-images={style} id={`portrait-additions-${style}`}>
      <span className="portrait-count">
        {count}/6장{reserved > 0 && ` · 대기 ${reserved}장`}
      </span>
      {persona.bio && (
        <button
          id={`portrait-add-${style}`}
          className="secondary"
          form="persona-editor"
          type="submit"
          name="intent"
          value="subportrait"
          formAction={`${action}?style=${style}`}
          data-portrait-operation={`subportrait:${style}`}
          data-portrait-style={style}
          data-portrait-label={copy.styles[style]}
          data-image-maximum={remaining}
          disabled={remaining <= 0}
          aria-label={`${copy.portraitLabels[style]} ${copy.addImage}`}
        >
          + 추가
        </button>
      )}
    </div>
  );
}
