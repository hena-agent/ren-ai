import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import { diagnosticCount } from "@codemirror/lint";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { renderCharacterSheet } from "./character-sheet.ts";
import { sheet } from "../test/character.ts";
import { legacy } from "../test/fixtures.ts";
import { useBrowser } from "../test/browser.ts";
import { documentStatus } from "./document-diagnostics.ts";
import { DocumentEditor } from "./document-editor.tsx";
import { bindDocumentEditor, destroyDocumentEditors } from "./document-editor-browser.ts";

useBrowser(destroyDocumentEditors);
const source = withPublicProfile(renderCharacterSheet(sheet), "안녕하세요.\n\n### 함께\n걸어요.");
const persona = {
  ...legacy,
  name: sheet.name,
  gender: sheet.gender,
  description: source,
  descriptionVersion: 2,
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));

test("diagnostics distinguish drafts and old content, group missing sections, and point to actual offending ranges", () => {
  expect(documentStatus(" \n", "").state).toBe("empty");
  expect(documentStatus(source, sheet.name, sheet.gender).state).toBe("valid");
  expect(documentStatus(source, sheet.name, undefined, true).state).toBe("valid");
  const old = documentStatus(
    withPublicProfile("기존 설정", "소개예요."),
    sheet.name,
    undefined,
    true,
  );
  expect(old).toMatchObject({ state: "legacy", issues: [] });
  const missing = documentStatus("기존 설정", sheet.name);
  expect(missing.state).toBe("invalid");
  expect(missing.issues).toHaveLength(2);
  expect(missing.issues[0]?.start).toBe("기존 설정".length);
  expect(documentStatus("## 정체성·외형\n작성 중", sheet.name).state).toBe("invalid");
  const duplicateSource = source.replace("## 취향", "## 습관");
  const duplicate = documentStatus(duplicateSource, sheet.name);
  expect(duplicate.issues.find((entry) => entry.section === "습관")?.start).toBe(
    duplicateSource.lastIndexOf("## 습관"),
  );
  const renamed = documentStatus(source, "다른 이름").issues[0]!;
  expect(source.slice(renamed.start, renamed.end)).toBe(`이름: ${sheet.name}`);
  expect(documentStatus(source, sheet.name, "male").issues[0]?.section).toBe("정체성·외형");
  expect(
    documentStatus(source.replace("성별: 여성", "성별: 남성"), sheet.name, "female").issues[0]
      ?.section,
  ).toBe("정체성·외형");
  expect(documentStatus(source.replace(sheet.background, ""), sheet.name).issues[0]?.section).toBe(
    "성장 배경",
  );
  const badSource = source.replace("자율성: 85", "자율성: 101");
  const invalid = documentStatus(badSource, sheet.name);
  expect(badSource.slice(invalid.issues[0]!.start, invalid.issues[0]!.end)).toContain(
    "자율성: 101",
  );
  expect(invalid.issues[0]?.line).toBe(56);
  expect(documentStatus(badSource.replaceAll("\n", "\r\n"), sheet.name)).toEqual(invalid);
  expect(documentStatus(`prefix\n${source}`, sheet.name).issues[0]?.section).toBe("문서 구조");
  expect(documentStatus(`${source}\n\n## 공개 프로필\n두 번째`, sheet.name).issues[0]?.start).toBe(
    source.length + 2,
  );
  expect(documentStatus(`${source}\n\n## 잘못된 제목\n글`, sheet.name).issues[0]?.start).toBe(
    source.length + 2,
  );
  expect(documentStatus(withPublicProfile(source, "### 먼저 제목"), sheet.name).state).toBe(
    "invalid",
  );
});

test("the document has one editable source, paragraph previews with a clear public boundary, and visible private conversion reports", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <DocumentEditor
      persona={persona}
      locked
      editing
      action="/personas/legacy"
      conversion={{ source: "이전 설정", additions: ["추가한 설정"] }}
    />,
  );
  const editor = document.querySelector<HTMLElement>("[data-document-editor]")!;
  expect(editor.querySelector("details")).toBeNull();
  expect(editor.querySelectorAll("textarea")).toHaveLength(1);
  expect(editor.querySelector("[data-document-status]")?.textContent).toContain("형식 정상");
  expect(editor.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(true);
  expect(editor.querySelector<HTMLButtonElement>('[value="convert"]')?.disabled).toBe(true);
  expect(editor.querySelector<HTMLButtonElement>('[value="convert"]')?.hidden).toBe(true);
  expect(editor.querySelector(".conversion-report")?.textContent).not.toContain("이전 설정");
  expect(editor.querySelector(".conversion-report")?.textContent).toContain("추가한 설정");
  expect(editor.querySelector(".private-document-preview")?.textContent).toContain("기본 성향");
  expect(editor.querySelector(".public-document-preview")?.textContent).not.toContain("기본 성향");
  const { description, ...promptOnly } = persona;
  expect(
    renderToStaticMarkup(
      <DocumentEditor
        persona={{ ...promptOnly, prompt: "비공개 초안" }}
        locked={false}
        editing={false}
        action="/personas"
      />,
    ),
  ).not.toContain("public-document-preview");
  expect(description).toBe(source);
  expect(
    renderToStaticMarkup(
      <DocumentEditor
        persona={persona}
        locked={false}
        editing
        action="/personas/legacy"
        conversion={{ source: "변환 전 원문", additions: [] }}
      />,
    ),
  ).not.toContain("conversion-report");
});

test("CodeMirror synchronizes the form immediately, previews safely, supports history and marks and selects an actual error", async () => {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <span data-editor-change-state>저장됨</span>
      <DocumentEditor persona={persona} locked={false} editing action="/personas/legacy" />
    </form>,
  );
  const form = document.querySelector("form")!;
  const textarea = form.querySelector<HTMLTextAreaElement>("textarea")!;
  const editor = form.querySelector<HTMLElement>("[data-document-editor]")!;
  bindDocumentEditor(form);
  bindDocumentEditor(form);
  const view = EditorView.findFromDOM(editor.querySelector(".cm-editor")!)!;
  expect(editor.querySelectorAll(".cm-editor")).toHaveLength(1);
  expect(textarea.hidden).toBe(true);
  expect(textarea.required).toBe(false);
  expect(view.lineWrapping).toBe(true);
  expect(diagnosticCount(view.state)).toBe(0);
  const editPane = editor.querySelector<HTMLElement>("#document-edit-pane")!;
  const previewPane = editor.querySelector<HTMLElement>("#document-preview-pane")!;
  const editButton = editor.querySelector<HTMLButtonElement>('[data-document-mode="edit"]')!;
  const previewButton = editor.querySelector<HTMLButtonElement>('[data-document-mode="preview"]')!;
  expect(editPane.hidden).toBe(false);
  expect(previewPane.hidden).toBe(true);
  view.dispatch({ selection: { anchor: 10 } });
  previewButton.click();
  expect(editPane.hidden).toBe(true);
  expect(previewPane.hidden).toBe(false);
  expect(previewButton.getAttribute("aria-pressed")).toBe("true");
  editButton.click();
  expect(view.state.selection.main.anchor).toBe(10);
  expect(textarea.value).toBe(source);
  expect(editPane.hidden).toBe(false);
  const offset = source.indexOf("자율성: 85") + "자율성: ".length;
  view.dispatch({ changes: { from: offset, to: offset + 2, insert: "101" } });
  expect(new FormData(form).get("description")).toContain("자율성: 101");
  await pause();
  expect(editor.dataset["format"]).toBe("invalid");
  expect(diagnosticCount(view.state)).toBe(1);
  expect(view.contentDOM.getAttribute("aria-invalid")).toBe("true");
  expect(editor.querySelector<HTMLButtonElement>("[data-document-convert]")?.hidden).toBe(false);
  previewButton.click();
  editor.querySelector<HTMLButtonElement>("[data-document-issues] button")!.click();
  expect(editPane.hidden).toBe(false);
  expect(
    view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
  ).toContain("자율성: 101");
  expect(form.querySelector("[data-editor-change-state]")?.textContent).toContain("저장 필요");
  expect(undo(view)).toBe(true);
  expect(textarea.value).toBe(source);
  expect(redo(view)).toBe(true);
  const staleError = editor.querySelector<HTMLButtonElement>("[data-document-issues] button")!;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  expect(() => staleError.click()).not.toThrow();
  expect(view.state.selection.main.from).toBe(0);
  await pause();
  expect(editor.dataset["format"]).toBe("empty");
  expect(editor.querySelector<HTMLButtonElement>("[data-document-convert]")?.hidden).toBe(true);
  textarea.value = `${source}\n\n### <img src=x onerror=alert(1)>\n새로운 단락`;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  expect(view.state.doc.toString()).toBe(textarea.value);
  expect(editor.querySelector("[data-document-preview]")?.textContent).toContain("새로운 단락");
  expect(editor.querySelector("[data-document-preview] img")).toBeNull();
  expect(editor.dataset["format"]).toBe("valid");
  expect(editor.querySelector<HTMLButtonElement>("[data-document-convert]")?.hidden).toBe(true);
  delete editor.dataset["gender"];
  const name = form.querySelector<HTMLInputElement>("#name")!;
  name.value = "다른 이름";
  name.dispatchEvent(new Event("input"));
  await pause();
  expect(editor.dataset["format"]).toBe("invalid");
  editor.dataset["gender"] = "male";
  name.dispatchEvent(new Event("input"));
  await pause();
  expect(editor.dataset["format"]).toBe("invalid");
  bindDocumentEditor(document.createElement("form"));
  destroyDocumentEditors();
  expect(editor.querySelector(".cm-editor")).toBeNull();
  name.dispatchEvent(new Event("input"));
  destroyDocumentEditors();
});

test("image work keeps the source read-only and uses the response style nonce", () => {
  document.head.innerHTML = '<meta name="style-nonce" content="test-nonce">';
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <span data-editor-change-state>저장됨</span>
      <DocumentEditor persona={persona} locked editing={false} action="/personas" />
    </form>,
  );
  const form = document.querySelector("form")!;
  bindDocumentEditor(form);
  const view = EditorView.findFromDOM(form.querySelector(".cm-editor")!)!;
  expect(view.state.facet(EditorState.readOnly)).toBe(true);
  expect(view.state.facet(EditorView.editable)).toBe(false);
  expect(view.state.facet(EditorView.cspNonce)).toBe("test-nonce");
});
