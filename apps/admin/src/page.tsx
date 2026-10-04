import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersonaRecord } from "@ren-ai/personas";
import { descriptionOf } from "./authoring.ts";
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

function Preview({ persona }: { persona: PersonaRecord }) {
  const portraits = persona.portraits;
  return (
    <article className="persona-card">
      {portraits ? (
        <div className="portrait-split">
          {(["anime", "photo"] as const).map((style) => (
            <Fragment key={style}>
              <div className={`portrait-pane portrait-${style}`}>
                <img
                  src={portraits[style].replace(/^\/discovery\/images\//, "/images/")}
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
      <ProfileContent persona={persona} />
    </article>
  );
}

function Comparison({
  persona,
  portraits,
}: {
  persona: PersonaRecord;
  portraits: NonNullable<PersonaRecord["portraits"]>;
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
          {Object.entries(portraits).map(([style, imageUrl]) => (
            <figure className="image-option" key={style}>
              <img
                src={imageUrl.replace(/^\/discovery\/images\//, "/images/")}
                alt={`${persona.name} ${style === "anime" ? copy.styles.anime : copy.styles.photo}`}
              />
              <figcaption>{style === "anime" ? copy.styles.anime : copy.styles.photo}</figcaption>
            </figure>
          ))}
        </div>
      </section>
      <ProfileContent persona={persona} />
    </article>
  );
}

function Editor({
  persona,
  editing,
  draft,
  seed,
  portraitInstructions,
}: {
  persona: PersonaRecord;
  editing: boolean;
  draft: string;
  seed?: string | undefined;
  portraitInstructions?: string | undefined;
}) {
  return (
    <div className="editor-layout">
      <div className="authoring-column">
        <form
          className="seed-form"
          action={editing ? `/personas/${persona.id}` : "/personas"}
          method="post"
          data-generating={copy.generating}
        >
          <input type="hidden" name="draft" value={draft} />
          <fieldset>
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
          action={editing ? `/personas/${persona.id}` : "/personas"}
          method="post"
          data-generating={copy.generating}
          data-saving={copy.saving}
        >
          <input type="hidden" name="draft" value={draft} />
          <button hidden type="submit" name="intent" value="save">
            {copy.save}
          </button>
          <dialog
            className="portrait-dialog"
            data-portrait-dialog
            aria-labelledby="portrait-dialog-title"
            aria-describedby="portrait-instructions-hint"
          >
            <h2 id="portrait-dialog-title">{copy.portraitDialogTitle}</h2>
            <p className="hint" id="portrait-instructions-hint">
              {copy.portraitInstructionsHint}
            </p>
            <label htmlFor="portrait-instructions">{copy.portraitInstructionsLabel}</label>
            <textarea
              id="portrait-instructions"
              name="portraitInstructions"
              rows={5}
              defaultValue={portraitInstructions}
              placeholder={copy.portraitInstructionsPlaceholder}
              aria-describedby="portrait-instructions-hint"
            />
            <div className="dialog-actions">
              <button className="secondary" type="button" data-portrait-cancel>
                {copy.portraitDialogCancel}
              </button>
              <button type="button" data-portrait-confirm>
                {copy.portraitDialogConfirm}
              </button>
            </div>
          </dialog>
          <fieldset>
            <legend>{copy.character}</legend>
            <label htmlFor="name">이름</label>
            <input id="name" name="name" defaultValue={persona.name} required />
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
            />
            <div className="generation-actions">
              <button type="submit" name="intent" value="generate">
                {persona.imageUrl && persona.bio ? copy.regenerate : copy.generate}
              </button>
            </div>
            <p className="hint">{copy.generationHint}</p>
            <output className="pending-status" data-pending aria-live="polite" />
          </fieldset>
          <fieldset>
            <legend>{copy.publication}</legend>
            <label className="toggle" htmlFor="published">
              <input
                id="published"
                name="published"
                type="checkbox"
                defaultChecked={persona.published}
              />
              {copy.published}
            </label>
            <p className="hint">{copy.publishHint}</p>
          </fieldset>
          <div className="form-actions">
            <button type="submit" name="intent" value="save">
              {copy.save}
            </button>
            <a href="/">{copy.list}</a>
          </div>
        </form>
      </div>
      <aside aria-labelledby="preview-title">
        <h2 id="preview-title">{copy.preview}</h2>
        <p className="hint">{copy.previewHint}</p>
        {persona.portraits ? (
          <Comparison persona={persona} portraits={persona.portraits} />
        ) : (
          <Preview persona={persona} />
        )}
      </aside>
    </div>
  );
}

export type PageContent =
  | {
      record: PersonaRecord;
      editing: boolean;
      draft: string;
      seed?: string | undefined;
      portraitInstructions?: string | undefined;
      personas?: never;
    }
  | {
      personas: readonly PersonaRecord[];
      record?: never;
      editing?: never;
      draft?: never;
      seed?: never;
      portraitInstructions?: never;
    };

export function renderPage({
  personas,
  record,
  editing,
  draft,
  error = "",
  saved,
  seed,
  portraitInstructions,
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
            {record ? (
              <Editor
                persona={record}
                editing={editing}
                draft={draft}
                seed={seed}
                portraitInstructions={portraitInstructions}
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
