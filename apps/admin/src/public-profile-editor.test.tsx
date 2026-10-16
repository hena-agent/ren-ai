import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";
import { expect, test, vi, beforeEach } from "vitest";
import { splitPersonaMarkdown, withPublicProfile } from "@ren-ai/personas/profile";
import { readProfileSections } from "@ren-ai/personas/profile-sections";
import { DocumentEditor } from "./document-editor.tsx";
import { bindDocumentEditor, destroyDocumentEditors } from "./document-editor-browser.ts";
import { useBrowser } from "../test/browser.ts";
import { character, legacy } from "../test/fixtures.ts";

useBrowser(() => act(() => destroyDocumentEditors()));
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
async function workspace(publicMarkdown = "소개예요.", locked = false) {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <span data-editor-change-state />
      <DocumentEditor
        persona={{
          ...legacy,
          ...character,
          description: withPublicProfile(character.description, publicMarkdown),
        }}
        locked={locked}
        editing
        action="/personas/legacy"
      />
    </form>,
  );
  const form = document.querySelector("form")!;
  await act(async () => {
    bindDocumentEditor(form);
  });
  return form;
}
const host = () => document.querySelector<HTMLElement>(".public-profile-editor")!;
const items = () => host().querySelectorAll<HTMLElement>(".profile-edit-section");
const source = () => document.querySelector<HTMLTextAreaElement>("#description")!;
const sections = () =>
  readProfileSections(splitPersonaMarkdown(source().value).publicMarkdown).sections;
function control(label: string, root: ParentNode = host()) {
  const field = [...root.querySelectorAll("label")].find((item) =>
    item.textContent?.startsWith(label),
  )!;
  return field.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    "input, textarea, select",
  )!;
}
async function edit(
  field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      field.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : field.tagName === "SELECT"
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(
      new Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(text: string, root: ParentNode = host()) {
  await act(async () => {
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === text)!
      .click();
  });
}

test("public items edit the single Markdown source, reorder, remove, and preserve private content and custom sections", async () => {
  const form = await workspace("소개예요.\n\n### 나만의 제목\n\n기존 **글**.");
  const privateSource = splitPersonaMarkdown(source().value).privateMarkdown;
  await edit(control("자기소개"), "바뀐 소개예요.");
  expect(source().value).toContain("바뀐 소개예요.");
  await edit(control("추가할 항목"), "관심사");
  await click("항목 추가");
  await edit(control("관심사 ·"), "재즈, 산책");
  expect(sections()[1]).toEqual({ title: "관심사", body: "- 재즈\n- 산책" });
  await click("↑", items()[1]);
  expect(sections()[0]?.title).toBe("관심사");
  await click("↓", items()[0]);
  await edit(control("제목", items()[0]), "내 취향");
  await edit(control("내용", items()[0]), "직접 수정한 글.");
  await click("항목 삭제", items()[1]);
  expect(sections()).toEqual([{ title: "내 취향", body: "직접 수정한 글." }]);
  await edit(control("추가할 항목"), "문답");
  await click("항목 추가");
  await edit(control("질문"), "좋아하는 주말은?");
  await edit(control("답변"), "책방에 가요.");
  expect(sections()[1]).toEqual({ title: "문답: 좋아하는 주말은?", body: "책방에 가요." });
  await edit(control("추가할 항목"), "자유 항목");
  await click("항목 추가");
  expect(sections()[2]?.title).toBe("나에 대해");
  expect(splitPersonaMarkdown(source().value).privateMarkdown).toBe(privateSource);
  const view = EditorView.findFromDOM(form.querySelector<HTMLElement>(".cm-editor")!)!;
  expect(view.state.doc.toString()).toBe(source().value);
  await act(async () => {
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: withPublicProfile(character.description, "원문에서 수정.\n\n### 관심사\n\n- 요리"),
      },
    });
  });
  await vi.waitFor(() => expect(control("관심사 ·").value).toBe("요리"));
});

test("fact rows have independent labels and values, can be removed, and noncanonical Markdown stays editable", async () => {
  await workspace();
  await edit(control("추가할 항목"), "라이프스타일");
  await click("항목 추가");
  await click("정보 추가");
  await edit(control("정보 이름"), "직업");
  await edit(control("정보 내용"), "도예가");
  expect(sections()[0]?.body).toBe("- 직업: 도예가");
  await click("정보 추가");
  expect(host().querySelectorAll(".profile-fact-fields input")).toHaveLength(4);
  await edit(control("정보 내용"), "사진가");
  expect(sections()[0]?.body).toContain("- 직업: 사진가");
  await click("정보 삭제");
  expect(sections()[0]?.body).toBe("- :");
  await click("정보 삭제");
  expect(sections()[0]?.body).toBe("");
  await act(async () => {
    source().value = withPublicProfile(
      character.description,
      "소개.\n\n### 라이프스타일\n\n자유롭게 쓴 기존 글.",
    );
    source().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await vi.waitFor(() =>
    expect(control("내용 · 기존 Markdown").value).toBe("자유롭게 쓴 기존 글."),
  );
  await edit(control("내용 · 기존 Markdown"), "원문을 유지하며 수정.");
  expect(sections()[0]?.body).toBe("원문을 유지하며 수정.");
});

test("basic information uses fixed optional fields and preserves extra public facts", async () => {
  await workspace("소개.\n\n### 기본 정보\n\n- 직업: 도예가\n- MBTI: INFP");
  expect(control("직업 ·").value).toBe("도예가");
  expect(control("나이 ·").value).toBe("");
  await edit(control("나이 ·"), "27세");
  await edit(control("지역 ·"), "서울");
  await edit(control("직업 ·"), "사진가");
  expect(sections()[0]?.body).toContain("- 직업: 사진가");
  await edit(control("나이 ·"), "");
  expect(sections()[0]?.body).not.toContain("나이:");
  await edit(control("정보 내용"), "ENFP");
  expect(sections()[0]?.body).toContain("- MBTI: ENFP");
  await click("정보 삭제");
  expect(sections()[0]?.body).not.toContain("MBTI");
  expect(sections()[0]?.body).toContain("- 지역: 서울");
  act(() => destroyDocumentEditors());
  await workspace("소개.\n\n### 기본 정보\n\n작성 중인 원문");
  expect(control("내용 · 기존 Markdown").value).toBe("작성 중인 원문");
  await edit(control("내용 · 기존 Markdown"), "- 직업: 도예가");
  expect(control("직업 ·").value).toBe("도예가");
  act(() => destroyDocumentEditors());
  await workspace();
  await click("항목 추가");
  expect(control("직업 ·").value).toBe("");
  await edit(control("직업 ·"), "도예가");
  expect(sections()[0]?.body).toBe("- 직업: 도예가");
});

test("invalid public boundaries disable item editing; image work locks all item controls", async () => {
  await workspace("소개.\n\n## 공개 프로필\n중복");
  expect(document.querySelector("[data-public-profile-editor]")?.textContent).toContain(
    "경계를 수정",
  );
  act(() => destroyDocumentEditors());
  await workspace("소개.\n\n### 관계 스타일\n\n- 연락: 천천히", true);
  expect(host().getAttribute("disabled")).not.toBeNull();
});
