import type { PersonaRecord } from "@ren-ai/personas";
import { personaImages } from "@ren-ai/personas";
import copy from "./copy.json";

export function PhotoAddPanel({
  persona,
  action,
  style,
  reserved,
  ready = false,
}: {
  persona: PersonaRecord;
  action: string;
  style: "anime" | "photo";
  reserved: number;
  ready?: boolean;
}) {
  const count = personaImages(persona).filter((image) => image.style === style).length;
  const remaining = 6 - count - reserved;
  return (
    <div className="photo-additions" data-add-images={style} id={`portrait-additions-${style}`}>
      <span className="portrait-count">
        {count}/6장{reserved > 0 && ` · 대기 ${reserved}장`}
      </span>
      <button
        id={`portrait-add-${style}`}
        className="secondary"
        form="persona-editor"
        type="submit"
        name="intent"
        value="generate"
        formAction={`${action}?style=${style}`}
        data-portrait-operation={`generate:${style}`}
        data-portrait-style={style}
        data-portrait-label={copy.styles[style]}
        data-image-maximum={remaining}
        disabled={remaining <= 0 || !ready}
        aria-label={`${copy.portraitLabels[style]} ${copy.addImage}`}
      >
        + 추가
      </button>
      {!ready && <span className="hint">인물 시트가 필요합니다.</span>}
    </div>
  );
}
