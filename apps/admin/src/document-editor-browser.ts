import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import { documentStatus } from "./document-diagnostics.ts";
import { DocumentPreview } from "./document-preview.tsx";
import { markdownEditor } from "./markdown-editor.ts";

const editors = new WeakMap<HTMLFormElement, () => void>();

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
  const preview = createRoot(editor.querySelector<HTMLElement>("[data-document-preview]")!);
  const sourcePane = editor.querySelector<HTMLElement>("#document-edit-pane")!;
  const previewPane = editor.querySelector<HTMLElement>("#document-preview-pane")!;
  const modeButtons = editor.querySelectorAll<HTMLButtonElement>("[data-document-mode]");
  const selectMode = (mode: string) => {
    sourcePane.hidden = mode !== "edit";
    previewPane.hidden = mode !== "preview";
    for (const button of modeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset["documentMode"] === mode));
      button.classList.toggle("secondary", button.dataset["documentMode"] !== mode);
    }
    view.requestMeasure();
  };
  for (const button of modeButtons)
    button.addEventListener("click", () => selectMode(button.dataset["documentMode"]!));
  source.hidden = true;
  source.required = false;
  const update = () => {
    const gender = editor.dataset["gender"];
    const result = documentStatus(
      source.value,
      name.value.trim(),
      gender === "female" || gender === "male" ? gender : undefined,
      editor.dataset["previousFormat"] === "true",
    );
    editor.dataset["format"] = result.state;
    view.contentDOM.setAttribute("aria-invalid", String(result.state === "invalid"));
    label.textContent = result.label;
    const convert = editor.querySelector<HTMLButtonElement>("[data-document-convert]");
    if (convert) convert.hidden = result.state === "valid" || result.state === "empty";
    view.dispatch(
      setDiagnostics(
        view.state,
        result.issues.map((entry) => ({
          from: entry.start,
          to: entry.end,
          severity: "error",
          message: `${entry.section}: ${entry.message}`,
        })),
      ),
    );
    preview.render(createElement(DocumentPreview, { source: source.value }));
    issues.replaceChildren(
      ...result.issues.map((entry) => {
        const item = form.ownerDocument.createElement("li");
        const button = form.ownerDocument.createElement("button");
        button.type = "button";
        button.textContent = `${entry.line}행 · ${entry.section}: ${entry.message}`;
        button.addEventListener("click", () => {
          selectMode("edit");
          const start = Math.min(entry.start, view.state.doc.length);
          const end = Math.min(entry.end, view.state.doc.length);
          view.dispatch({
            selection: { anchor: start, head: end },
            effects: EditorView.scrollIntoView(start, { y: "center" }),
          });
          view.focus();
        });
        item.append(button);
        return item;
      }),
    );
  };
  let timer = 0;
  const schedule = () => {
    if (source.value !== view.state.doc.toString())
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source.value } });
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 250);
  };
  const changed = () => {
    form.querySelector<HTMLElement>("[data-editor-change-state]")!.textContent =
      "편집 중 · 저장 필요";
  };
  source.addEventListener("input", schedule);
  name.addEventListener("input", schedule);
  form.addEventListener("input", changed);
  editors.set(form, () => {
    window.clearTimeout(timer);
    source.removeEventListener("input", schedule);
    name.removeEventListener("input", schedule);
    form.removeEventListener("input", changed);
    preview.unmount();
    view.destroy();
    editors.delete(form);
  });
  update();
}
