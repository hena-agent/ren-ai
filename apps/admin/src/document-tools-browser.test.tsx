import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { undo } from "@codemirror/commands";
import { expect, test, vi } from "vitest";
import { splitPersonaMarkdown, withPublicProfile } from "@ren-ai/personas/profile";
import { readProfileSections } from "@ren-ai/personas/profile-sections";
import { DocumentEditor } from "./document-editor.tsx";
import { PublicPersonaPreview } from "./public-persona-preview.tsx";
import { bindDocumentEditor, destroyDocumentEditors } from "./document-editor-browser.ts";
import { useBrowser } from "../test/browser.ts";
import { character, legacy } from "../test/fixtures.ts";
import type { Draft } from "./draft.ts";
import { bindPending } from "./pending.ts";

useBrowser(destroyDocumentEditors);
function workspace(conversion?: Draft["conversion"], locked = false) {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <span data-editor-change-state />
      <DocumentEditor
        persona={{ ...legacy, ...character }}
        locked={locked}
        editing
        action="/personas/legacy"
        conversion={conversion}
      />
      <div data-public-preview data-images="[]">
        <PublicPersonaPreview name={character.name} source={character.description} images={[]} />
      </div>
    </form>,
  );
  const form = document.querySelector("form")!;
  bindDocumentEditor(form);
  const view = EditorView.findFromDOM(form.querySelector<HTMLElement>(".cm-editor")!)!;
  const field = form.querySelector<HTMLTextAreaElement>("#description")!;
  return { form, view, field };
}

test("the single Markdown editor edits, reorders and removes public sections while preserving private content and updating the preview", async () => {
  const { form, view, field } = workspace();
  expect(form.querySelector("[data-public-profile-editor]")).toBeNull();
  const privateSource = splitPersonaMarkdown(field.value).privateMarkdown;
  const publicMarkdown =
    "바뀐 소개예요.\n\n### 기본 정보\n\n- 직업: 도예가\n\n### 관심사\n\n- 재즈\n- 산책\n\n### 문답: 좋아하는 주말은?\n\n책방에 가요.\n\n### 나만의 제목\n\n기존 **글**.";
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: withPublicProfile(field.value, publicMarkdown),
    },
  });
  const sections = readProfileSections(splitPersonaMarkdown(field.value).publicMarkdown).sections;
  expect(sections).toEqual([
    { title: "기본 정보", body: "- 직업: 도예가" },
    { title: "관심사", body: "- 재즈\n- 산책" },
    { title: "문답: 좋아하는 주말은?", body: "책방에 가요." },
    { title: "나만의 제목", body: "기존 **글**." },
  ]);
  const preview = form.querySelector<HTMLElement>("[data-public-preview]")!;
  await vi.waitFor(() => expect(preview.textContent).toContain("책방에 가요."));
  expect(preview.querySelector(".profile-interests")?.textContent).toContain("재즈");
  expect(preview.textContent).not.toContain("비공개 설정");
  const reordered = withPublicProfile(
    field.value,
    "바뀐 소개예요.\n\n### 나만의 제목\n\n직접 수정한 글.\n\n### 관심사\n\n- 요리",
  );
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: reordered } });
  expect(field.value).toBe(reordered);
  expect(new FormData(form).get("description")).toBe(reordered);
  expect(splitPersonaMarkdown(field.value).privateMarkdown).toBe(privateSource);
  await vi.waitFor(() => expect(preview.textContent).toContain("직접 수정한 글."));
  expect(preview.textContent).not.toContain("책방에 가요.");
});

test("improvement options stay in a modal; cancel preserves inputs and confirmation submits the current draft", () => {
  const { form, field } = workspace();
  const trigger = form.querySelector<HTMLButtonElement>("#open-improvement")!;
  const dialog = form.querySelector<HTMLDialogElement>("#improvement-dialog")!;
  const prompt = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  const submitted = vi.fn<(body: FormData) => void>();
  bindPending(form);
  form.addEventListener("submit", (event) => {
    submitted(new FormData(form, event.submitter));
    event.preventDefault();
  });
  expect(dialog.open).toBe(false);
  expect(
    getChunks(EditorView.findFromDOM(form.querySelector<HTMLElement>(".cm-editor")!)!.state),
  ).toBeNull();
  trigger.focus();
  trigger.click();
  expect(dialog.open).toBe(true);
  prompt.value = "주말을 더 구체적으로";
  dialog.querySelector<HTMLButtonElement>("[data-close-document-dialog]")!.click();
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(submitted).not.toHaveBeenCalled();
  trigger.click();
  expect(prompt.value).toBe("주말을 더 구체적으로");
  dialog.querySelector<HTMLSelectElement>("select")!.value = "profile";
  dialog.querySelector<HTMLButtonElement>('[value="improve"]')!.click();
  expect(submitted).toHaveBeenCalledTimes(1);
  const body: FormData = submitted.mock.calls[0]![0];
  expect(body.get("intent")).toBe("improve");
  expect(body.get("improvementInstructions")).toBe(prompt.value);
  expect(body.get("improvementScope")).toBe("profile");
  expect(body.get("description")).toBe(field.value);
  expect(dialog.querySelector("[data-improvement-pending]")?.textContent).toContain(
    "개선하고 있습니다",
  );
  window.dispatchEvent(new Event("pageshow"));
  expect(dialog.querySelector("[data-improvement-pending]")?.textContent).toBe("");
});

test("public-profile navigation selects the real Markdown heading, ignoring headings inside code blocks; help stays out of the draft", () => {
  const { form, view, field } = workspace();
  const source = "비공개\n\n```md\n## 공개 프로필\n```\n\n## 공개 프로필\n\n공개 소개";
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source } });
  form.querySelector<HTMLButtonElement>("[data-jump-public-profile]")!.click();
  expect(view.state.selection.main.from).toBe(source.lastIndexOf("## 공개 프로필"));
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
    "## 공개 프로필",
  );
  expect(view.hasFocus).toBe(true);
  const help = form.querySelector<HTMLDialogElement>("#profile-help-dialog")!;
  const trigger = form.querySelector<HTMLButtonElement>("#open-profile-help")!;
  trigger.click();
  expect(help.open).toBe(true);
  expect(document.activeElement).toBe(help.querySelector("h2"));
  for (const text of [
    "기본 정보",
    "관심사",
    "라이프스타일",
    "관계 스타일",
    "문답:",
    "### 내가 편해지는 순간",
  ])
    expect(help.textContent).toContain(text);
  help.querySelector<HTMLButtonElement>("[data-close-document-dialog]")!.click();
  expect(help.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(field.value).toBe(source);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "작성 중" } });
  form.querySelector<HTMLButtonElement>("[data-jump-public-profile]")!.click();
  expect(help.open).toBe(true);
  expect(field.value).toBe("작성 중");
});

test("inline changes compare against the request source and can be hidden without changing content, history or the save payload", () => {
  const original = character.description.replace("밤에는 오래 걸어요", "아침에는 산책해요");
  const { form, view, field } = workspace({ source: original, additions: [] });
  const toggle = form.querySelector<HTMLInputElement>("[data-improvement-diff]")!;
  expect(getOriginalDoc(view.state).toString()).toBe(original);
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  expect(form.querySelector(".improvement-diff details")).toBeNull();
  expect(form.querySelector(".cm-chunkButtons")).toBeNull();
  view.dispatch({ changes: { from: view.state.doc.length, insert: "\n\n직접 추가한 내용" } });
  expect(field.value).toBe(`${character.description}\n\n직접 추가한 내용`);
  expect(getChunks(view.state)?.chunks.length).toBeGreaterThan(0);
  toggle.checked = false;
  toggle.dispatchEvent(new Event("change"));
  expect(getChunks(view.state)).toBeNull();
  expect(new FormData(form).get("description")).toBe(field.value);
  expect(new FormData(form).has("improvementSource")).toBe(false);
  expect(undo(view)).toBe(true);
  expect(field.value).toBe(character.description);
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change"));
  expect(getOriginalDoc(view.state).toString()).toBe(original);
  expect(getChunks(view.state)?.chunks).toHaveLength(1);
  expect(undo(view)).toBe(true);
  expect(field.value).toBe(original);
  expect(getChunks(view.state)?.chunks).toHaveLength(0);
});

test("queued image work locks improvement and source editing while help remains available", () => {
  const { form } = workspace(undefined, true);
  expect(form.querySelector<HTMLButtonElement>("#open-improvement")!.disabled).toBe(true);
  expect(form.querySelector<HTMLTextAreaElement>("#description")!.readOnly).toBe(true);
  form.querySelector<HTMLButtonElement>("#open-profile-help")!.click();
  expect(form.querySelector<HTMLDialogElement>("#profile-help-dialog")!.open).toBe(true);
});
