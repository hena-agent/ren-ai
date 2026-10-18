import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { diagnosticCount } from "@codemirror/lint";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { documentStatus, publicationIssues, renderCharacterSheet } from "@ren-ai/personas";
import { sheet } from "../test/character.ts";
import { legacy } from "../test/fixtures.ts";
import { useBrowser } from "../test/browser.ts";
import { DocumentEditor } from "./document-editor.tsx";
import { bindDocumentEditor, destroyDocumentEditors } from "./document-editor-browser.ts";
import { markdownEditor } from "./markdown-editor.ts";

useBrowser(destroyDocumentEditors);
const source = withPublicProfile(renderCharacterSheet(sheet), "안녕하세요.\n\n### 함께\n걸어요.");
const persona = {
  ...legacy,
  name: sheet.name,
  gender: sheet.gender,
  description: source,
  descriptionVersion: 2,
};

test("editor and publication accept public prose and lists under every section title", () => {
  for (const content of [
    "### 기본 정보\n직접 작성한 소개예요.",
    "### 기본 정보\n- 직업:",
    "### 기본 정보\n- 직업: 도예가\n- 직업: 사진가",
    "### 관심사\n재즈, 산책",
    "### 라이프스타일\n- 주말:",
    "### 관계 스타일\n연락은 자주 해요.",
    "### 문답:\n답변만 있어요.",
    "### 문답: &nbsp;\n답변만 있어요.",
  ]) {
    const description = withPublicProfile(source, `소개.\n\n${content}`);
    const result = documentStatus(description, sheet.name, sheet.gender);
    expect(
      publicationIssues({ ...persona, description }).filter((issue) => issue.tab === "persona"),
    ).toEqual([]);
    expect(result).toMatchObject({ state: "valid", issues: [] });
  }
  for (const content of [
    "### 관심사\n- 재즈\n- 산책",
    "### 기본 정보\n- 직업: 도예가",
    "### 문답: 쉬는 날은?\n산책해요.",
    "### 자유 제목\n자유롭게 써요.",
  ]) {
    const description = withPublicProfile(source, `소개.\n\n${content}`);
    expect(documentStatus(description, sheet.name, sheet.gender).state).toBe("valid");
    expect(
      publicationIssues({ ...persona, description }).filter((issue) => issue.tab === "persona"),
    ).toEqual([]);
  }
});

test("diagnostics distinguish drafts and old content, group missing sections, and point to actual offending ranges", () => {
  expect(documentStatus(" \n", "").state).toBe("empty");
  expect(documentStatus(source, sheet.name, sheet.gender).state).toBe("valid");
  expect(documentStatus(source, sheet.name, undefined, true).state).toBe("valid");
  expect(
    documentStatus(withPublicProfile("기존 설정", "소개예요."), sheet.name, undefined, true),
  ).toMatchObject({ state: "legacy", issues: [] });
  const missing = documentStatus("기존 설정", sheet.name);
  expect(missing.state).toBe("invalid");
  expect(missing.issues).toHaveLength(2);
  expect(missing.issues[0]?.start).toBe("기존 설정".length);
  expect(documentStatus("## 정체성·외형\n작성 중", sheet.name).state).toBe("invalid");
  const duplicateSource = source.replace("## 취향", "## 습관");
  expect(
    documentStatus(duplicateSource, sheet.name).issues.find((entry) => entry.section === "습관")
      ?.start,
  ).toBe(duplicateSource.lastIndexOf("## 습관"));
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
  expect(invalid.issues[0]?.line).toBe(57);
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

test("editor diagnostics select the real error in Persona without a document preview toggle", async () => {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <span data-editor-change-state />
      <DocumentEditor
        persona={persona}
        locked={false}
        editing
        action="/personas/legacy"
        conversion={{ source: "old", additions: ["보강한 설정"] }}
      />
    </form>,
  );
  const form = document.querySelector("form")!;
  bindDocumentEditor(form);
  const field = form.querySelector<HTMLTextAreaElement>("#description")!;
  const view = EditorView.findFromDOM(form.querySelector<HTMLElement>(".cm-editor")!)!;
  expect(field.hidden).toBe(true);
  field.value = source.replace("자율성: 85", "자율성: 101");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(diagnosticCount(view.state)).toBe(1));
  form.querySelector<HTMLButtonElement>('[data-editor-tab="memory"]')!.click();
  const stale = form.querySelector<HTMLButtonElement>("[data-document-issues] button")!;
  stale.click();
  expect(form.querySelector<HTMLElement>("#pane-persona")!.hidden).toBe(false);
  expect(
    view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
  ).toContain("자율성: 101");
  field.value = withPublicProfile(source, "소개.\n\n### 관심사\n재즈, 산책");
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() =>
    expect(form.querySelector("[data-document-status]")?.textContent).toBe("형식 정상"),
  );
  expect(diagnosticCount(view.state)).toBe(0);
  expect(form.querySelector("[data-document-issues]")?.textContent).toBe("");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  expect(() => stale.click()).not.toThrow();
  expect(view.state.selection.main.from).toBe(0);
  expect(form.querySelector("[data-document-mode]")).toBeNull();
  expect(form.querySelector(".improvement-diff")?.textContent).toContain("보강한 설정");
  destroyDocumentEditors();
  bindDocumentEditor(document.createElement("form"));
});

test("source rendering preserves prompt-only drafts, read-only editing and response nonce with shared accessible defaults", () => {
  document.head.innerHTML = '<meta name="style-nonce" content="test-nonce">';
  const { description: _description, ...promptOnly } = legacy;
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <span data-editor-change-state />
      <DocumentEditor
        persona={{ ...promptOnly, name: sheet.name, gender: sheet.gender, prompt: source }}
        locked
        editing={false}
        action="/personas"
      />
    </form>,
  );
  const form = document.querySelector("form")!;
  bindDocumentEditor(form);
  const view = EditorView.findFromDOM(form.querySelector<HTMLElement>(".cm-editor")!)!;
  expect(view.state.facet(EditorState.readOnly)).toBe(true);
  expect(view.state.facet(EditorView.editable)).toBe(false);
  expect(view.state.facet(EditorView.cspNonce)).toBe("test-nonce");
  destroyDocumentEditors();
  const sourceField = document.createElement("textarea");
  const host = document.createElement("div");
  document.body.append(host);
  const plain = markdownEditor(host, sourceField);
  expect(plain.contentDOM.getAttribute("aria-label")).toBe("persona.md Markdown 원문");
  plain.destroy();
});
