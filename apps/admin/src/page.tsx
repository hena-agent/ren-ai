import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { personaImages } from "@ren-ai/personas";
import type { PersonaRecord } from "@ren-ai/personas";
import { descriptionOf, needsIntroduction } from "./authoring.ts";
import copy from "./copy.json";
import { SubPortraitPanel } from "./sub-portrait-panel.tsx";
import { ImageOptions } from "./image-options.tsx";
import { ImageJobPanel } from "./image-job-panel.tsx";
import type { ImageJob } from "./image-queue.ts";

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

function Preview({
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
            data-source-bound
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
            data-source-bound
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

function Comparison({
  persona,
  action,
  locked,
}: {
  persona: PersonaRecord;
  portraits: NonNullable<PersonaRecord["portraits"]>;
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
                data-source-bound
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
                data-source-bound
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

interface EditorFields {
  editing: boolean;
  draft: string;
  seed?: string | undefined;
  portraitInstructions?: string | undefined;
  portraitOperation?: string | undefined;
  imageCount?: number | undefined;
  imagePrompts?: readonly string[] | undefined;
  imageJob?: ImageJob | undefined;
  imageJobs?: readonly { job: ImageJob; position: number }[] | undefined;
  imageReservations?: { anime: number; photo: number } | undefined;
  queuePosition?: number | undefined;
  queueObservedAt?: number | undefined;
  profileSource?: PersonaRecord | undefined;
}

function Editor({
  persona,
  editing,
  draft,
  seed,
  portraitInstructions,
  portraitOperation,
  imageCount,
  imagePrompts,
  imageJob,
  imageJobs,
  imageReservations,
  profileSource,
}: EditorFields & { persona: PersonaRecord }) {
  const portraits = persona.portraits;
  const source = profileSource ?? persona;
  const complete = Boolean(source.bio && source.imageUrl);
  const action = editing ? `/personas/${persona.id}` : "/personas";
  const gender = persona.gender ?? "female";
  const locked = (imageJobs ?? [{ job: imageJob }]).some(
    ({ job }) => job?.state === "queued" || job?.state === "running",
  );
  return (
    <div className="editor-layout">
      <div className="authoring-column">
        {!editing && (
          <fieldset disabled={locked}>
            <legend>{copy.genderTitle}</legend>
            <label htmlFor="gender">{copy.genderLabel}</label>
            <select
              id="gender"
              data-persona-gender
              defaultValue={gender}
              aria-describedby="gender-hint"
            >
              <option value="female">{copy.female}</option>
              <option value="male" disabled>
                {copy.maleUnavailable}
              </option>
            </select>
            <p className="hint" id="gender-hint">
              {copy.genderHint}
            </p>
          </fieldset>
        )}
        <form className="seed-form" action={action} method="post" data-generating={copy.generating}>
          <input type="hidden" name="draft" value={draft} />
          {!editing && <input type="hidden" name="gender" value={gender} />}
          <fieldset disabled={locked}>
            <legend>{copy.seedTitle}</legend>
            <label htmlFor="seed">{copy.seedLabel}</label>
            <textarea
              id="seed"
              name="seed"
              rows={3}
              defaultValue={seed}
              placeholder={copy.seedPlaceholder}
              aria-describedby="seed-hint"
              required
            />
            <p className="hint" id="seed-hint">
              {copy.seedHint}
            </p>
            <button type="submit" name="intent" value="character">
              {copy.seedGenerate}
            </button>
            <output className="pending-status" data-pending aria-live="polite" />
          </fieldset>
        </form>
        <form
          id="persona-editor"
          action={action}
          method="post"
          data-generating={copy.generating}
          data-saving={copy.saving}
          data-adding={copy.addingScene}
          data-regenerating={copy.regeneratingImage}
          data-profile-complete={String(complete)}
          data-source-name={source.name}
          data-source-description={descriptionOf(source)}
          data-image-queue
          data-queue-locked={String(locked)}
        >
          <input type="hidden" name="draft" value={draft} />
          {!editing && <input type="hidden" name="gender" value={gender} />}
          <button hidden type="submit" name="intent" value="save" disabled={locked}>
            {copy.save}
          </button>
          <ImageOptions
            prompt={portraitInstructions}
            operation={portraitOperation}
            count={imageCount}
            prompts={imagePrompts}
          />
          <fieldset>
            <legend>{copy.character}</legend>
            <label htmlFor="name">이름</label>
            <input id="name" name="name" defaultValue={persona.name} required readOnly={locked} />
            <label htmlFor="description">캐릭터 설명</label>
            <p className="hint" id="description-hint">
              {copy.characterHint}
            </p>
            <textarea
              id="description"
              name="description"
              rows={16}
              defaultValue={descriptionOf(persona)}
              placeholder={copy.characterPlaceholder}
              aria-describedby="description-hint"
              required
              readOnly={locked}
            />
            <div className="generation-actions">
              <button
                hidden={complete && !needsIntroduction(persona, source)}
                type="submit"
                name="intent"
                value="generate"
                disabled={locked}
                data-portrait-label={copy.baseImageCost}
              >
                {persona.imageUrl && persona.bio ? copy.regenerate : copy.generate}
              </button>
            </div>
            <p className="hint">{copy.generationHint}</p>
            <output className="pending-status" data-pending aria-live="polite" />
          </fieldset>
          <div data-add-images>
            {persona.bio && (
              <SubPortraitPanel
                persona={persona}
                action={action}
                reservations={imageReservations}
              />
            )}
          </div>
          {persona.bio && (
            <fieldset>
              <legend>{copy.introductionTitle}</legend>
              <p>{persona.bio}</p>
              <button
                data-source-bound
                className="secondary"
                type="submit"
                name="intent"
                value="introduction"
                disabled={locked}
              >
                {copy.regenerateIntroduction}
              </button>
              <p className="hint">{copy.introductionHint}</p>
            </fieldset>
          )}
          <fieldset>
            <legend>{copy.publication}</legend>
            <label className="toggle" htmlFor="published">
              <input
                id="published"
                name="published"
                type="checkbox"
                defaultChecked={persona.published}
                disabled={locked}
              />
              {copy.published}
            </label>
            <p className="hint">{copy.publishHint}</p>
          </fieldset>
          <div className="form-actions">
            <button type="submit" name="intent" value="save" disabled={locked}>
              {copy.save}
            </button>
            <a href="/">{copy.list}</a>
          </div>
        </form>
      </div>
      <aside aria-labelledby="preview-title">
        <h2 id="preview-title">{copy.preview}</h2>
        <p className="hint">{copy.previewHint}</p>
        {portraits ? (
          <Comparison persona={persona} portraits={portraits} action={action} locked={locked} />
        ) : (
          <Preview persona={persona} action={action} locked={locked} />
        )}
      </aside>
    </div>
  );
}

export type PageContent =
  | (EditorFields & { record: PersonaRecord; personas?: never })
  | ({ personas: readonly PersonaRecord[]; record?: never } & {
      [Field in keyof EditorFields]?: never;
    });

export function renderPage({
  personas,
  record,
  editing,
  draft,
  error = "",
  saved,
  seed,
  portraitInstructions,
  portraitOperation,
  imageCount,
  imagePrompts,
  imageJob,
  imageJobs,
  imageReservations,
  queuePosition,
  queueObservedAt,
  profileSource,
}: PageContent & {
  error?: string;
  saved?: boolean;
}) {
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang="ko">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{copy.title}</title>
          <link rel="stylesheet" href="/style.css" />
          <script src="/pending.js" defer />
        </head>
        <body>
          <a className="skip-link" href="#main">
            {copy.skip}
          </a>
          <header>
            <a className="brand" href="/">
              {copy.brand}
            </a>
            <nav aria-label={copy.navigation}>
              <a href="/" aria-current={record ? undefined : "page"}>
                {copy.list}
              </a>
              <a className="new-link" href="/new">
                + {copy.new}
              </a>
            </nav>
          </header>
          <main id="main">
            <div className="page-heading">
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1>{record ? (editing ? record.name : copy.new) : copy.list}</h1>
              <p className="description">{copy.description}</p>
            </div>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {saved && <output className="notice success">{copy.saved}</output>}
            {imageJob && (
              <div data-image-progress>
                {(imageJobs ?? [{ job: imageJob, position: queuePosition! }]).map(
                  (entry, index) => (
                    <ImageJobPanel
                      key={entry.job.id}
                      job={entry.job}
                      position={entry.position}
                      now={queueObservedAt!}
                      titleId={index === 0 ? "image-queue-title" : `image-queue-${entry.job.id}`}
                    />
                  ),
                )}
              </div>
            )}
            {record ? (
              <Editor
                persona={record}
                editing={editing}
                draft={draft}
                seed={seed}
                portraitInstructions={portraitInstructions}
                portraitOperation={portraitOperation}
                imageCount={imageCount}
                imagePrompts={imagePrompts}
                imageJob={imageJob}
                imageJobs={imageJobs}
                imageReservations={imageReservations}
                profileSource={profileSource}
              />
            ) : personas.length ? (
              <div className="persona-grid">
                {personas.map((persona) => (
                  <div key={persona.id}>
                    <a className="card-link" href={`/personas/${persona.id}`}>
                      <Preview persona={persona} />
                      <span className="edit-label">{copy.edit}</span>
                    </a>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                <p>{copy.empty}</p>
                <a href="/new">{copy.start} →</a>
              </div>
            )}
          </main>
        </body>
      </html>,
    )
  );
}
