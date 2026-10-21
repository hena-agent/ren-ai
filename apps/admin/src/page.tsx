import { renderToStaticMarkup } from "react-dom/server";
import { publicationIssues } from "@ren-ai/personas";
import type { PersonaRecord, InitialDocuments, IdentitySheets } from "@ren-ai/personas";
import copy from "./copy.json";
import { ImageOptions } from "./image-options.tsx";
import { ImageJobPanel } from "./image-job-panel.tsx";
import type { ImageJob } from "./image-queue.ts";
import { DocumentEditor } from "./document-editor.tsx";
import type { Draft } from "./draft.ts";
import { PersonaList, type PersonaListing } from "./persona-list.tsx";
import { ContactPage } from "./contact-page.tsx";
import type { ContactView } from "./contact-page.tsx";
import { UploadDialog } from "./upload-controls.tsx";
import { VersionPage } from "./version-page.tsx";
import type { VersionView } from "./version-page.tsx";
import { ConversationPage, type ConversationView } from "./conversation-page.tsx";
import { PortraitManager } from "./portrait-manager.tsx";

interface EditorFields {
  sheets?: IdentitySheets | undefined;
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
  improvementInput?: Draft["improvementInput"];
}

function needsCreation(persona: PersonaRecord, editing: boolean, retry: boolean) {
  return !persona.name || retry || (!editing && !persona.bio);
}

function Editor({
  sheets,
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
  improvementInput,
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
          {editing && persona.version && (
            <div className="profile-item-actions">
              <span>현재 v{persona.version}</span>
              <button
                type="submit"
                className="secondary"
                formAction={`${action}/versions`}
                disabled={locked}
              >
                버전 기록
              </button>
            </div>
          )}
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
              improvementInput={improvementInput}
              documents={documents}
              tab={tab}
            />
          </div>
          <PortraitManager
            persona={persona}
            action={action}
            locked={locked}
            sheets={sheets}
            reservations={imageReservations}
            jobs={imageJobs ?? [{ job: imageJob }]}
          />
        </div>
        <output className="pending-status" data-pending aria-live="polite" />
        <UploadDialog />
      </form>
    </div>
  );
}

export type PageContent =
  | (EditorFields & { record: PersonaRecord; personas?: never })
  | ({ personas: readonly PersonaRecord[]; record?: never; listing?: PersonaListing } & {
      [Field in keyof EditorFields]?: never;
    });

function heading(view: ContactView | undefined) {
  if (view) return view.tab === "waitlist" ? "대기자 관리" : "첫 연락 현황";
  return copy.list;
}

function PageNotices({
  error,
  saved,
  catalogPending,
  imageJob,
  imageJobs,
  queuePosition,
  queueObservedAt,
}: Pick<EditorFields, "imageJob" | "imageJobs" | "queuePosition" | "queueObservedAt"> & {
  error: string;
  saved?: boolean | undefined;
  catalogPending?: boolean | undefined;
}) {
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {saved && <output className="notice success">{copy.saved}</output>}
      {catalogPending && (
        <output className="notice">
          저장된 카탈로그의 메시징 서버 적용을 기다리고 있습니다. 연결이 복구되면 자동으로
          재시도합니다.
        </output>
      )}
      {imageJob && (
        <div data-image-progress>
          {(imageJobs ?? [{ job: imageJob, position: queuePosition! }]).map((entry, index) => (
            <ImageJobPanel
              key={entry.job.id}
              job={entry.job}
              position={entry.position}
              now={queueObservedAt!}
              titleId={index === 0 ? "image-queue-title" : `image-queue-${entry.job.id}`}
            />
          ))}
        </div>
      )}
    </>
  );
}

function Navigation({
  record,
  contactView,
  conversationView,
  recoveryAvailable,
}: {
  record: PersonaRecord | undefined;
  contactView: ContactView | undefined;
  conversationView: ConversationView | undefined;
  recoveryAvailable?: boolean;
}) {
  return (
    <nav aria-label={copy.navigation}>
      <a href="/" aria-current={record || contactView || conversationView ? undefined : "page"}>
        {copy.list}
      </a>
      <a className="new-link" href="/new">
        + {copy.new}
      </a>
      {recoveryAvailable && <a href="/editing-recovery">편집 기록 복구 파일</a>}
      <a href="/waitlist" aria-current={contactView?.tab === "waitlist" ? "page" : undefined}>
        대기자
      </a>
      <a
        href="/first-contacts"
        aria-current={contactView?.tab === "first-contacts" ? "page" : undefined}
      >
        첫 연락
      </a>
      <a href="/conversations" aria-current={conversationView ? "page" : undefined}>
        대화 상태
      </a>
    </nav>
  );
}

export function renderPage({
  sheets,
  personas,
  record,
  editing,
  draft,
  error = "",
  saved,
  catalogPending,
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
  improvementInput,
  changed,
  documents,
  tab,
  showIdea,
  contactView,
  versionView,
  conversationView,
  recoveryAvailable,
  listing,
}: PageContent & {
  error?: string;
  saved?: boolean;
  catalogPending?: boolean | undefined;
  contactView?: ContactView;
  versionView?: VersionView;
  conversationView?: ConversationView;
  recoveryAvailable?: boolean;
  listing?: PersonaListing;
}) {
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang="ko">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{copy.title}</title>
          <link rel="icon" type="image/svg+xml" href="/brand.svg" />
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
            <Navigation
              record={record}
              contactView={contactView}
              conversationView={conversationView}
              {...(recoveryAvailable !== undefined && { recoveryAvailable })}
            />
            <a href="/seeding">Seeding runs</a>
          </header>
          <main id="main" className={record || versionView ? "persona-workbench" : undefined}>
            <div
              className="page-heading"
              hidden={Boolean(record || versionView || conversationView)}
            >
              <p className="eyebrow">{contactView ? "ONBOARDING" : copy.eyebrow}</p>
              <h1>{heading(contactView)}</h1>
              <p className="description">
                {contactView ? "대기자 선정과 첫 연락 진행 상태를 관리합니다." : copy.description}
              </p>
            </div>
            <PageNotices
              error={error}
              saved={saved}
              catalogPending={catalogPending}
              imageJob={imageJob}
              imageJobs={imageJobs}
              queuePosition={queuePosition}
              queueObservedAt={queueObservedAt}
            />
            {conversationView ? (
              <ConversationPage view={conversationView} />
            ) : versionView ? (
              <VersionPage {...versionView} />
            ) : contactView ? (
              <ContactPage view={contactView} />
            ) : record ? (
              <Editor
                sheets={sheets}
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
                improvementInput={improvementInput}
                changed={changed}
                documents={documents}
                tab={tab}
                showIdea={showIdea}
              />
            ) : (
              <PersonaList personas={personas} listing={listing} />
            )}
          </main>
        </body>
      </html>,
    )
  );
}
