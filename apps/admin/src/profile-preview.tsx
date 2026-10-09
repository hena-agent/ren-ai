import { Fragment } from "react";
import { personaImages } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import copy from "./copy.json";
import { SubPortraitPanel } from "./sub-portrait-panel.tsx";

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
                    src={portraits[style]!.replace(/^\/discovery\/images\//, "/images/")}
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
          src={persona.imageUrl.replace(/^\/discovery\/images\//, "/images/")}
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
  persona,
  action,
  locked,
  reservations = { anime: 0, photo: 0 },
}: {
  persona: PersonaRecord;
  action: string;
  locked: boolean;
  reservations?: { anime: number; photo: number } | undefined;
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
            <SubPortraitPanel
              persona={persona}
              action={action}
              style={style}
              reserved={reservations[style]}
            />
          </div>
          <p className="portrait-style-description">{copy.styles[style]}</p>
          <div className="image-options-grid" data-image-preview id={`portrait-gallery-${style}`}>
            {images
              .filter((image) => image.style === style)
              .map(({ imageUrl, main }, index) => (
                <figure className="image-option" key={imageUrl}>
                  <img
                    src={imageUrl.replace(/^\/discovery\/images\//, "/images/")}
                    alt={`${persona.name} ${copy.styles[style]} · ${main ? "메인" : `추가 ${index}`}`}
                    width={800}
                    height={1000}
                    loading="lazy"
                  />
                  <figcaption>{main ? "메인" : `추가 ${index}`}</figcaption>
                  <div className="portrait-image-actions">
                    <button
                      id={`portrait-regenerate-${style}-${index}`}
                      className="image-regenerate secondary"
                      form="persona-editor"
                      type="submit"
                      name="intent"
                      value="regenerate"
                      data-portrait-style={style}
                      data-image-index={index}
                      formAction={`${action}?image=${encodeURIComponent(imageUrl)}&style=${style}`}
                      data-portrait-operation={`regenerate:${style}:${imageUrl}`}
                      data-portrait-label={`${main ? copy.mainImage : copy.secondaryImage} · ${copy.styles[style]} · ${copy.singleImageCost}`}
                      aria-label={`${copy.portraitLabels[style]} ${main ? "메인" : `추가 ${index}`} 다시 생성`}
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
                      data-confirm-delete={`${copy.portraitLabels[style]} ${main ? "메인" : `추가 ${index}`} 사진을 삭제할까요?${main ? " 같은 스타일의 다음 사진이 메인이 됩니다. 남은 사진이 없으면 이 스타일은 빈 상태로 표시됩니다." : ""} 저장하기 전까지 공개된 사진은 유지됩니다.`}
                      aria-label={`${copy.portraitLabels[style]} ${main ? "메인" : `추가 ${index}`} 삭제`}
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
