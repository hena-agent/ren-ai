import { renderToStaticMarkup } from "react-dom/server";
import type { PersonaRecord } from "@ren-ai/personas";
import copy from "./copy.json";

export const emptyPersona: PersonaRecord = {
  id: "",
  name: "",
  bio: "",
  imageUrl: "",
  published: false,
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "",
  memory: "",
  prompt: "",
};

const profileFields = [
  { name: "name", label: "이름", type: "text" },
  { name: "imageUrl", label: "프로필 이미지 URL", type: "url" },
] as const;
const runtimeFields = [
  { name: "language", label: "언어" },
  { name: "timeZone", label: "시간대" },
] as const;
const longFields = [
  { name: "openingLine", label: "첫 인사 지침", rows: 3 },
  { name: "memory", label: "기억 지침", rows: 4 },
  { name: "prompt", label: "페르소나 프롬프트", rows: 12 },
] as const;

function Preview({ persona }: { persona: PersonaRecord }) {
  return (
    <article className="persona-card">
      {persona.imageUrl ? (
        <img src={persona.imageUrl} alt={`${persona.name} 프로필`} />
      ) : (
        <div className="image-placeholder">{copy.noImage}</div>
      )}
      <div className="card-content">
        <span className={persona.published ? "badge live" : "badge"}>
          {persona.published ? copy.live : copy.draft}
        </span>
        <h3>{persona.name || copy.noName}</h3>
        <p>{persona.bio || copy.noBio}</p>
      </div>
    </article>
  );
}

function Editor({ persona, editing }: { persona: PersonaRecord; editing: boolean }) {
  return (
    <div className="editor-layout">
      <form action={editing ? `/personas/${persona.id}` : "/personas"} method="post">
        <fieldset>
          <legend>{copy.profile}</legend>
          <label htmlFor="id">ID</label>
          <input
            id="id"
            name="id"
            defaultValue={persona.id}
            readOnly={editing}
            required
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"
            aria-describedby="id-hint"
          />
          <p className="hint" id="id-hint">
            {copy.idHint}
          </p>
          {profileFields.map((field) => (
            <div className="field" key={field.name}>
              <label htmlFor={field.name}>{field.label}</label>
              <input
                id={field.name}
                name={field.name}
                type={field.type}
                defaultValue={persona[field.name]}
                required={field.name === "name"}
              />
            </div>
          ))}
          <label htmlFor="bio">짧은 소개</label>
          <textarea id="bio" name="bio" rows={3} defaultValue={persona.bio} />
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
        <fieldset>
          <legend>{copy.runtime}</legend>
          <p className="hint runtime-hint">{copy.runtimeHint}</p>
          <div className="field-pair">
            {runtimeFields.map((field) => (
              <div className="field" key={field.name}>
                <label htmlFor={field.name}>{field.label}</label>
                <input
                  id={field.name}
                  name={field.name}
                  defaultValue={persona[field.name]}
                  required
                />
              </div>
            ))}
          </div>
          {longFields.map((field) => (
            <div className="field" key={field.name}>
              <label htmlFor={field.name}>{field.label}</label>
              <textarea
                id={field.name}
                name={field.name}
                rows={field.rows}
                defaultValue={persona[field.name]}
                required
              />
            </div>
          ))}
        </fieldset>
        <div className="form-actions">
          <button type="submit">{copy.save}</button>
          <a href="/">{copy.list}</a>
        </div>
      </form>
      <aside aria-labelledby="preview-title">
        <h2 id="preview-title">{copy.preview}</h2>
        <p className="hint">{copy.previewHint}</p>
        <Preview persona={persona} />
      </aside>
    </div>
  );
}

export function renderPage({
  personas,
  record,
  editing,
  error = "",
  saved = false,
}: {
  personas: readonly PersonaRecord[];
  record?: PersonaRecord | undefined;
  editing?: boolean | undefined;
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
              <Editor persona={record} editing={editing === true} />
            ) : personas.length ? (
              <div className="persona-grid">
                {personas.map((persona) => (
                  <div key={persona.id}>
                    <a className="card-link" href={`/personas/${persona.id}`}>
                      <Preview persona={persona} />
                      <span className="card-id">{persona.id} / EDIT →</span>
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
