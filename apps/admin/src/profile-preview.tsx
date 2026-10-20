import { Fragment } from "react";
import { personaImages } from "@ren-ai/personas";
import type { PersonaRecord, IdentitySheets } from "@ren-ai/personas";
import copy from "./copy.json";
import { PhotoAddPanel } from "./photo-add-panel.tsx";
import { UploadControls } from "./upload-controls.tsx";

function ProfileContent({ persona }: { persona: PersonaRecord }) {
  return (
    <div className="card-content">
      <span className={persona.published ? "badge live" : "badge"}>
        {persona.published ? copy.live : copy.draft}
      </span>
      <h3>{persona.name || copy.noName}</h3>
      <p>{persona.bio || copy.noBio}</p>
    </div>
  );
}

export function Preview({ persona }: { persona: PersonaRecord }) {
  const portraits = persona.portraits;
  return (
    <article className="persona-card">
      {portraits ? (
        <div className="portrait-split">
          {(["anime", "photo"] as const)
            .filter((style) => portraits[style])
            .map((style) => (
              <Fragment key={style}>
                <div className={`portrait-pane portrait-${style}`}>
                  <img
                    src={portraits[style]}
                    alt={`${persona.name} ${copy.styles[style]}`}
                    width={800}
                    height={1000}
                    loading="lazy"
                  />
                </div>
                <span className={`portrait-label portrait-label-${style}`} aria-hidden="true">
                  {copy.portraitLabels[style]}
                </span>
              </Fragment>
            ))}
        </div>
      ) : persona.imageUrl ? (
        <img
          src={persona.imageUrl}
          alt={`${persona.name} 프로필`}
          width={800}
          height={1000}
          loading="lazy"
        />
      ) : (
        <div className="image-placeholder">{copy.noImage}</div>
      )}
      <ProfileContent persona={persona} />
    </article>
  );
}

export function Comparison({
  sheets = {},
  sheetBusy = false,
  persona,
  action,
  locked,
  reservations = { anime: 0, photo: 0 },
}: {
  persona: PersonaRecord;
  action: string;
  locked: boolean;
  reservations?: { anime: number; photo: number } | undefined;
  sheets?: IdentitySheets | undefined;
  sheetBusy?: boolean;
}) {
  const images = personaImages(persona);
  return (
    <section className="image-options" aria-label={copy.comparison}>
      {(["photo", "anime"] as const).map((style) => (
        <section className="portrait-style" key={style} aria-labelledby={`portrait-${style}-title`}>
          <div className="portrait-style-heading">
            <h3 id={`portrait-${style}-title`} tabIndex={-1}>
              {style === "photo" ? "실사" : "애니풍"}
            </h3>
            <PhotoAddPanel
              persona={persona}
              action={action}
              style={style}
              reserved={reservations[style]}
              ready={Boolean(sheets[style]) && !sheetBusy}
            />
          </div>
          <UploadControls
            portraitStyle={style}
            locked={locked}
            full={images.filter((image) => image.style === style).length + reservations[style] >= 6}
          />
          <div className="image-options-grid" data-image-preview id={`portrait-gallery-${style}`}>
            {images
              .filter((image) => image.style === style)
              .map(({ imageUrl }, index) => (
                <figure className="image-option" key={imageUrl}>
                  <a
                    href={imageUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${copy.portraitLabels[style]} 사진 ${index + 1} 크게 보기`}
                  >
                    <img
                      src={imageUrl}
                      alt={`${persona.name} ${copy.styles[style]} · 사진 ${index + 1}`}
                      width={800}
                      height={1000}
                      loading="lazy"
                    />
                  </a>
                  <figcaption>사진 {index + 1}</figcaption>
                  <div className="portrait-image-actions">
                    <button
                      type="submit"
                      name="intent"
                      value="sheet"
                      className="secondary"
                      disabled={locked}
                      formAction={`${action}?image=${encodeURIComponent(imageUrl)}&style=${style}`}
                      data-portrait-style={style}
                      data-portrait-operation={`sheet:${style}:${imageUrl}`}
                      data-portrait-label={`${copy.portraitLabels[style]} 이 사진에서 인물 시트 1장 생성`}
                    >
                      이 사진으로 시트 만들기
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      data-upload-style={style}
                      data-upload-image={imageUrl}
                      disabled={locked}
                    >
                      파일로 교체
                    </button>
                    <button
                      id={`portrait-regenerate-${style}-${index}`}
                      className="image-regenerate secondary"
                      form="persona-editor"
                      type="submit"
                      name="intent"
                      value="regenerate"
                      disabled={!sheets[style] || sheetBusy}
                      data-portrait-style={style}
                      data-image-index={index}
                      formAction={`${action}?image=${encodeURIComponent(imageUrl)}&style=${style}`}
                      data-portrait-operation={`regenerate:${style}:${imageUrl}`}
                      data-portrait-label={`사진 ${index + 1} · ${copy.styles[style]} · ${copy.singleImageCost}`}
                      aria-label={`${copy.portraitLabels[style]} 사진 ${index + 1} 다시 생성`}
                    >
                      다시 생성
                    </button>
                    <button
                      id={`portrait-delete-${style}-${index}`}
                      className="secondary image-delete"
                      form="persona-editor"
                      type="submit"
                      name="intent"
                      value="delete-image"
                      disabled={locked}
                      formAction={`${action}?image=${encodeURIComponent(imageUrl)}&style=${style}`}
                      data-confirm-delete={`${copy.portraitLabels[style]} 사진 ${index + 1}을 삭제할까요? 인물 시트와 다른 사진은 유지됩니다. 저장하기 전까지 공개된 사진은 유지됩니다.`}
                      aria-label={`${copy.portraitLabels[style]} 사진 ${index + 1} 삭제`}
                    >
                      삭제
                    </button>
                  </div>
                </figure>
              ))}
            {!images.some((image) => image.style === style) && (
              <p className="portrait-empty">
                아직 {style === "photo" ? "실사" : "애니풍"} 사진이 없습니다.
              </p>
            )}
          </div>
        </section>
      ))}
    </section>
  );
}
