import { Fragment } from "react";
import { personaImages } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import copy from "./copy.json";

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

export function Preview({
  persona,
  action,
  locked,
}: {
  persona: PersonaRecord;
  action?: string;
  locked?: boolean;
}) {
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
        />
      ) : (
        <div className="image-placeholder">{copy.noImage}</div>
      )}
      {action && !portraits && persona.imageUrl && (
        <>
          <button
            form="persona-editor"
            type="submit"
            name="intent"
            value="regenerate"
            data-portrait-style="photo"
            formAction={`${action}?image=${encodeURIComponent(persona.imageUrl)}&style=photo`}
            data-portrait-operation={`regenerate:photo:${persona.imageUrl}`}
            data-portrait-label={copy.singleImageCost}
          >
            {copy.regenerateImage}
          </button>
          <button
            className="secondary"
            form="persona-editor"
            type="submit"
            name="intent"
            value="delete-image"
            disabled={locked}
            formAction={`${action}?image=${encodeURIComponent(persona.imageUrl)}&style=photo`}
          >
            {copy.deleteImage}
          </button>
        </>
      )}
      <ProfileContent persona={persona} />
    </article>
  );
}

export function Comparison({
  persona,
  action,
  locked,
}: {
  persona: PersonaRecord;
  action: string;
  locked: boolean;
}) {
  return (
    <article className="persona-card">
      <section
        className="image-options"
        aria-labelledby="comparison-title"
        aria-describedby="comparison-hint"
      >
        <h3 className="image-options-title" id="comparison-title">
          {copy.comparison}
        </h3>
        <p className="hint" id="comparison-hint">
          {copy.comparisonHint}
        </p>
        <div className="image-options-grid">
          {personaImages(persona).map(({ style, imageUrl, main }) => (
            <figure className="image-option" key={imageUrl}>
              <img
                src={imageUrl.replace(/^\/discovery\/images\//, "/images/")}
                alt={`${persona.name} ${style === "anime" ? copy.styles.anime : copy.styles.photo}`}
              />
              <figcaption>
                {main ? copy.mainImage : copy.secondaryImage} · {copy.styles[style]}
              </figcaption>
              <button
                className="image-regenerate"
                form="persona-editor"
                type="submit"
                name="intent"
                value="regenerate"
                data-portrait-style={style}
                data-image-index={personaImages(persona)
                  .filter((image) => image.style === style)
                  .findIndex((image) => image.imageUrl === imageUrl)}
                formAction={`${action}?image=${encodeURIComponent(imageUrl)}&style=${style}`}
                data-portrait-operation={`regenerate:${style}:${imageUrl}`}
                data-portrait-label={`${main ? copy.mainImage : copy.secondaryImage} · ${copy.styles[style]} · ${copy.singleImageCost}`}
              >
                {copy.regenerateImage}
              </button>
              <button
                className="secondary"
                form="persona-editor"
                type="submit"
                name="intent"
                value="delete-image"
                disabled={locked}
                formAction={`${action}?image=${encodeURIComponent(imageUrl)}&style=${style}`}
              >
                {copy.deleteImage}
              </button>
            </figure>
          ))}
        </div>
      </section>
      <ProfileContent persona={persona} />
    </article>
  );
}
