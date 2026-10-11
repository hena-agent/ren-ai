import { renderToStaticMarkup } from "react-dom/server";
import { publicationIssues, personaImages } from "@ren-ai/personas";
import type { PersonaRecord, InitialDocuments } from "@ren-ai/personas";
import copy from "./copy.json";
import { ImageOptions } from "./image-options.tsx";
import { ImageJobPanel } from "./image-job-panel.tsx";
import type { ImageJob } from "./image-queue.ts";
import { DocumentEditor } from "./document-editor.tsx";
import { InspectionResults } from "./inspection-page.tsx";
import type { InspectionRow } from "./inspection-page.tsx";
import type { Draft } from "./draft.ts";
import { Preview, Comparison } from "./profile-preview.tsx";
import { PublicPersonaPreview } from "./public-persona-preview.tsx";

interface EditorFields {
  documents?: InitialDocuments | undefined;
  tab?: Draft["tab"];
  showIdea?: boolean | undefined;
  changed?: boolean | undefined;
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
  conversion?: Draft["conversion"] | undefined;
}

function needsCreation(persona: PersonaRecord, editing: boolean, retry: boolean) {
  return !persona.name || retry || (!editing && !persona.bio);
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
  conversion,
  changed = true,
  documents = { state: "", memory: "" },
  tab,
  showIdea = false,
}: EditorFields & { persona: PersonaRecord }) {
  const action = editing ? `/personas/${persona.id}` : "/personas";
  const gender = persona.gender ?? "female";
  const requirements = publicationIssues(persona, documents);
  const locked = (imageJobs ?? [{ job: imageJob }]).some(
    ({ job }) => job?.state === "queued" || job?.state === "running",
  );
  return (
    <div className="persona-authoring">
      {needsCreation(persona, editing, showIdea) && (
        <div className="persona-creation">
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
          <form
            className="seed-form"
            action={action}
            method="post"
            data-generating={copy.generating}
          >
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
        </div>
      )}
      <form
        id="persona-editor"
        action={action}
        method="post"
        data-generating={copy.generating}
        data-saving={copy.saving}
        data-adding={copy.addingScene}
        data-regenerating={copy.regeneratingImage}
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
        <div className="editor-toolbar form-actions">
          <a className="editor-back" href="/" aria-label="페르소나 목록">
            ← 목록
          </a>
          <h1 className="editor-name">{persona.name || copy.new}</h1>
          <span className="editor-change-state" data-editor-change-state aria-live="polite">
            {!persona.name ? "생성 전" : changed ? "저장 전 미리보기" : "저장됨"}
          </span>
          <label className="toggle" htmlFor="published" title={copy.publishHint}>
            <input
              id="published"
              name="published"
              type="checkbox"
              defaultChecked={persona.published}
              disabled={locked || (!persona.published && requirements.length > 0)}
            />
            {copy.published}
          </label>
          <button type="submit" name="intent" value="save" disabled={locked}>
            {copy.save}
          </button>
        </div>
        <div className="publication-status" data-publication-status aria-live="polite">
          {[...new Set(requirements.map((issue) => issue.tab))].map((key) => (
            <span key={key}>
              {key === "persona" ? "Persona" : key === "state" ? "State" : "Memory"} 확인 필요
            </span>
          ))}
        </div>
        <div className="editor-layout">
          <div className="authoring-column">
            <DocumentEditor
              persona={persona}
              locked={locked}
              editing={editing}
              action={action}
              conversion={conversion}
              documents={documents}
              tab={tab}
            />
          </div>
          <aside className="portrait-manager" aria-labelledby="preview-title">
            <div
              data-public-preview
              data-images={JSON.stringify(
                personaImages(persona).map(({ style, imageUrl }) => ({ style, imageUrl })),
              )}
            >
              <PublicPersonaPreview
                name={persona.name}
                source={persona.description ?? persona.prompt}
                images={personaImages(persona)}
              />
            </div>
            <div className="portrait-manager-heading">
              <h2 id="preview-title">프로필 사진</h2>
              <button
                className="secondary"
                form="persona-editor"
                type="submit"
                name="intent"
                value="generate"
                disabled={locked}
                data-portrait-label={copy.baseImageCost}
              >
                {persona.imageUrl && persona.bio ? copy.regenerate : copy.generate}
              </button>
            </div>
            <p className="hint">스타일별 최대 6장 · 변경한 사진은 저장 후 공개됩니다.</p>
            <Comparison
              persona={persona}
              action={action}
              locked={locked}
              reservations={imageReservations}
            />
          </aside>
        </div>
        <output className="pending-status" data-pending aria-live="polite" />
      </form>
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
  conversion,
  inspections,
  changed,
  documents,
  tab,
  showIdea,
}: PageContent & {
  error?: string;
  saved?: boolean;
  inspections?: readonly InspectionRow[];
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
          <script src="/pending.js" type="module" />
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
              <a href="/inspection">전체 검사</a>
            </nav>
          </header>
          <main id="main" className={record ? "persona-workbench" : undefined}>
            <div className="page-heading" hidden={Boolean(record)}>
              <p className="eyebrow">{copy.eyebrow}</p>
              <h1>{inspections ? "Persona 형식 검사" : copy.list}</h1>
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
            {inspections ? (
              <InspectionResults rows={inspections} />
            ) : record ? (
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
                conversion={conversion}
                changed={changed}
                documents={documents}
                tab={tab}
                showIdea={showIdea}
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
