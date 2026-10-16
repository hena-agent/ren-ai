import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Schema } from "effect";
import { publicationIssues, stateStatus } from "@ren-ai/personas";
import { documentStatus } from "./document-diagnostics.ts";
import { PublicPersonaPreview } from "./public-persona-preview.tsx";
import { markdownEditor } from "./markdown-editor.ts";
import { bindDocumentTabs } from "./document-tabs.ts";
import { updateEditorDiagnostics } from "./editor-diagnostics.ts";
import { bindDocumentTools } from "./document-tools-browser.ts";
import { LanguagePanel } from "./language-panel.tsx";

const Images = Schema.Array(
  Schema.Struct({ style: Schema.Literals(["anime", "photo"]), imageUrl: Schema.String }),
);
const editors = new WeakMap<HTMLFormElement, () => void>();
function updatePublication(
  form: HTMLFormElement,
  requirements: ReturnType<typeof publicationIssues>,
  readOnly: boolean,
  selectTab: ReturnType<typeof bindDocumentTabs>,
) {
  const published = form.querySelector<HTMLInputElement>("#published");
  if (published) published.disabled = readOnly || (!published.checked && requirements.length > 0);
  const readiness = form.querySelector<HTMLElement>("[data-publication-status]");
  if (!readiness) return;
  readiness.replaceChildren();
  const names = { persona: "Persona", state: "State", memory: "Memory" };
  for (const key of new Set(requirements.map((requirement) => requirement.tab))) {
    const button = form.ownerDocument.createElement("button");
    button.type = "button";
    button.textContent = `${names[key]} 확인 필요`;
    button.title = requirements
      .filter((requirement) => requirement.tab === key)
      .map((requirement) => requirement.message)
      .join(" ");
    button.addEventListener("click", () => selectTab(key, true));
    readiness.append(button);
  }
  if (!requirements.length) readiness.textContent = "공개할 준비가 되었습니다.";
}
export function destroyDocumentEditors() {
  for (const form of document.querySelectorAll("form")) editors.get(form)?.();
}

export function bindDocumentEditor(form: HTMLFormElement) {
  const editor = form.querySelector<HTMLElement>("[data-document-editor]");
  if (!editor || editors.has(form)) return;
  const source = form.querySelector<HTMLTextAreaElement>("#description")!;
  const name = form.querySelector<HTMLInputElement>("#name")!;
  const issues = editor.querySelector<HTMLElement>("[data-document-issues]")!;
  const label = editor.querySelector<HTMLElement>("[data-document-status]")!;
  const window = form.ownerDocument.defaultView!;
  const view = markdownEditor(editor.querySelector<HTMLElement>("[data-markdown-editor]")!, source);
  bindDocumentTools(editor, view);
  const state = form.querySelector<HTMLTextAreaElement>('[name="stateSource"]')!;
  const memory = form.querySelector<HTMLTextAreaElement>('[name="memorySource"]')!;
  const languages = createRoot(editor.querySelector<HTMLElement>("[data-language-panel]")!);
  const initialViews = [state, memory].map((field) => {
    field.hidden = true;
    return markdownEditor(
      field.parentElement!.querySelector<HTMLElement>("[data-initial-markdown-editor]")!,
      field,
      field === state ? "yaml" : "markdown",
    );
  });
  const selectTab = bindDocumentTabs(form, () => {
    for (const current of [view, ...initialViews]) current.requestMeasure();
  });
  const host = form.querySelector<HTMLElement>("[data-public-preview]");
  const preview = host ? createRoot(host) : undefined;
  source.hidden = true;
  source.required = false;
  const update = () => {
    const title = form.querySelector<HTMLElement>(".editor-name");
    if (title) title.textContent = name.value.trim() || "새 페르소나";
    const gender = editor.dataset["gender"];
    const result = documentStatus(
      source.value,
      name.value.trim(),
      gender === "female" || gender === "male" ? gender : undefined,
      editor.dataset["previousFormat"] === "true",
    );
    editor.dataset["format"] = result.state;
    label.textContent = result.label;
    updateEditorDiagnostics(
      view,
      source,
      issues,
      result.issues.map((issue) => ({ ...issue, message: `${issue.section}: ${issue.message}` })),
      () => selectTab("persona"),
    );
    const stateResult = stateStatus(state.value, source.value);
    languages.render(
      createElement(LanguagePanel, {
        source: source.value,
        documents: { state: state.value, memory: memory.value },
        locked: source.readOnly || result.state !== "valid",
      }),
    );
    const statePane = form.querySelector<HTMLElement>("#pane-state")!;
    statePane.dataset["stateFormat"] = stateResult.state;
    statePane.querySelector<HTMLElement>("[data-state-status]")!.textContent = stateResult.label;
    updateEditorDiagnostics(
      initialViews[0]!,
      state,
      statePane.querySelector<HTMLElement>("[data-state-issues]")!,
      stateResult.issues,
      () => selectTab("state"),
    );
    for (const key of ["state", "memory"])
      form.querySelector<HTMLButtonElement>(`button[value="${key}"]`)!.disabled =
        source.readOnly || result.state !== "valid";
    const images = Schema.decodeUnknownSync(Images)(JSON.parse(host?.dataset["images"] ?? "[]"));
    preview?.render(
      createElement(PublicPersonaPreview, { name: name.value, source: source.value, images }),
    );
    const requirements = publicationIssues(
      {
        name: name.value.trim(),
        prompt: source.value,
        ...(gender === "female" || gender === "male" ? { gender } : {}),
        imageUrl: images[0]?.imageUrl ?? "",
      },
      { state: state.value, memory: memory.value },
    );
    updatePublication(form, requirements, source.readOnly, selectTab);
  };
  let timer = 0;
  const schedule = () => {
    for (const [field, current] of [
      [source, view],
      [state, initialViews[0]!],
      [memory, initialViews[1]!],
    ] as const)
      if (field.value !== current.state.doc.toString())
        current.dispatch({
          changes: { from: 0, to: current.state.doc.length, insert: field.value },
        });
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 250);
    form.querySelector<HTMLElement>("[data-editor-change-state]")!.textContent =
      "편집 중 · 저장 필요";
  };
  form.addEventListener("input", schedule);
  form.addEventListener("photos-updated", update);
  editors.set(form, () => {
    window.clearTimeout(timer);
    form.removeEventListener("input", schedule);
    form.removeEventListener("photos-updated", update);
    preview?.unmount();
    languages.unmount();
    for (const current of [view, ...initialViews]) current.destroy();
    editors.delete(form);
  });
  update();
}
