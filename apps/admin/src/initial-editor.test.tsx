import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { DocumentEditor } from "./document-editor.tsx";
import { PublicPersonaPreview } from "./public-persona-preview.tsx";
import { bindDocumentEditor, destroyDocumentEditors } from "./document-editor-browser.ts";
import { useBrowser } from "../test/browser.ts";
import { initialDocs, initialPersona } from "../test/initial.ts";
import { personaImages } from "@ren-ai/personas";
import { diagnosticCount } from "@codemirror/lint";

useBrowser(destroyDocumentEditors);
function workspace(locked = false) {
  document.body.innerHTML = renderToStaticMarkup(
    <form>
      <h1 className="editor-name">{initialPersona.name}</h1>
      <span data-editor-change-state>저장됨</span>
      <input id="published" type="checkbox" />
      <div data-publication-status />
      <DocumentEditor
        persona={initialPersona}
        locked={locked}
        editing
        action="/personas/harin"
        documents={initialDocs}
      />
      <div data-public-preview data-images={JSON.stringify(personaImages(initialPersona))}>
        <PublicPersonaPreview
          name={initialPersona.name}
          source={initialPersona.description}
          images={personaImages(initialPersona)}
        />
      </div>
    </form>,
  );
  const form = document.querySelector("form")!;
  bindDocumentEditor(form);
  return form;
}

test("tabs preserve source/history, expose distinct languages and support keyboard navigation", () => {
  const form = workspace();
  bindDocumentEditor(form);
  expect(form.querySelectorAll(".cm-editor")).toHaveLength(3);
  expect(form.querySelector("[data-document-mode]")).toBeNull();
  const views = [...form.querySelectorAll<HTMLElement>(".cm-editor")].map((el) =>
    EditorView.findFromDOM(el)!,
  );
  expect(markdownLanguage.isActiveAt(views[0]!.state, 0)).toBe(true);
  expect(yamlLanguage.isActiveAt(views[1]!.state, 0)).toBe(true);
  const tab = form.querySelector<HTMLButtonElement>('[data-editor-tab="state"]')!;
  tab.click();
  expect(form.querySelector<HTMLElement>("#pane-persona")!.hidden).toBe(true);
  views[1]!.dispatch({ changes: { from: 0, to: 0, insert: "\n" } });
  form.querySelector<HTMLButtonElement>('[data-editor-tab="memory"]')!.click();
  expect(new FormData(form).get("stateSource")).toBe("\n" + initialDocs.state);
  tab.click();
  undo(views[1]!);
  expect(new FormData(form).get("stateSource")).toBe(initialDocs.state);
  for (const [key, expected] of [
    ["ArrowRight", "memory"],
    ["Home", "persona"],
    ["End", "memory"],
    ["ArrowLeft", "persona"],
  ] as const) {
    tab.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
    expect(form.querySelector<HTMLInputElement>('[name="tab"]')!.value).toBe(expected);
  }
  tab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  destroyDocumentEditors();
  expect(form.querySelector(".cm-editor")).toBeNull();
});

test("the real public preview updates from editing, excludes internal text, and publication readiness follows all documents", async () => {
  const form = workspace();
  const preview = form.querySelector<HTMLElement>("[data-public-preview]")!;
  await vi.waitFor(() => expect(preview.textContent).toContain("천천히 알아가요."));
  expect(preview.textContent).not.toContain("도움 요청 회피");
  const memory = form.querySelector<HTMLTextAreaElement>('[name="memorySource"]')!;
  memory.value = "# 현재 생활";
  memory.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() =>
    expect(form.querySelector<HTMLInputElement>("#published")!.disabled).toBe(true),
  );
  form.querySelector<HTMLButtonElement>("[data-publication-status] button:last-child")!.click();
  expect(form.querySelector<HTMLInputElement>('[name="tab"]')!.value).toBe("memory");
  memory.value = initialDocs.memory;
  memory.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() =>
    expect(form.querySelector<HTMLInputElement>("#published")!.disabled).toBe(false),
  );
  const name = form.querySelector<HTMLInputElement>("#name")!;
  name.value = "바뀐 이름";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(preview.textContent).toContain("바뀐 이름"));
  expect(form.querySelector(".editor-name")?.textContent).toBe("바뀐 이름");
  name.value = "";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() =>
    expect(form.querySelector(".editor-name")?.textContent).toBe("새 페르소나"),
  );
});

test("queued work makes every document read-only", () => {
  const form = workspace(true);
  for (const field of form.querySelectorAll<HTMLTextAreaElement>("textarea"))
    expect(field.readOnly).toBe(true);
  for (const host of form.querySelectorAll<HTMLElement>(".cm-editor"))
    expect(EditorView.findFromDOM(host)!.contentDOM.getAttribute("contenteditable")).toBe("false");
});

test("profile styles and photo navigation remain interactive while a photo update clamps the selected index", async () => {
  const form = workspace();
  const host = form.querySelector<HTMLElement>("[data-public-preview]")!;
  const images = [
    { style: "photo", imageUrl: "https://example.net/one.jpg" },
    { style: "photo", imageUrl: "https://example.net/two.jpg" },
    { style: "anime", imageUrl: "https://example.net/anime.jpg" },
  ];
  host.dataset["images"] = JSON.stringify(images);
  form.dispatchEvent(new Event("photos-updated"));
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="다음 프로필 사진"]')).not.toBeNull(),
  );
  host.querySelector<HTMLButtonElement>('[aria-label="다음 프로필 사진"]')!.click();
  await vi.waitFor(() => expect(host.querySelector("img")?.src).toContain("two.jpg"));
  host.querySelector<HTMLButtonElement>('[aria-label="이전 프로필 사진"]')!.click();
  await vi.waitFor(() => expect(host.querySelector("img")?.src).toContain("one.jpg"));
  host.querySelectorAll<HTMLButtonElement>(".preview-style-controls button")[1]!.click();
  await vi.waitFor(() => expect(host.querySelector("img")?.src).toContain("anime.jpg"));
  host.querySelectorAll<HTMLButtonElement>(".preview-style-controls button")[0]!.click();
  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="다음 프로필 사진"]')).not.toBeNull(),
  );
  host.querySelector<HTMLButtonElement>('[aria-label="다음 프로필 사진"]')!.click();
  host.dataset["images"] = JSON.stringify([images[0]]);
  form.dispatchEvent(new Event("photos-updated"));
  await vi.waitFor(() => expect(host.querySelector("img")?.src).toContain("one.jpg"));
  expect(host.querySelector(".preview-photo-controls")).toBeNull();
});

test("missing or malformed public boundaries never render internal Persona content", () => {
  for (const source of [
    "Private secret",
    "Private secret\n\n## 공개 프로필\n공개\n\n## 공개 프로필\n중복",
  ]) {
    const markup = renderToStaticMarkup(
      <PublicPersonaPreview name="" source={source} images={[]} />,
    );
    expect(markup).not.toContain("Private secret");
    expect(markup).toContain("새 페르소나");
    expect(markup).toContain("아직 이 스타일의 사진이 없습니다");
  }
});

test("legacy gender metadata and an already published invalid draft still allow explicit unpublishing", async () => {
  const form = workspace();
  const editor = form.querySelector<HTMLElement>("[data-document-editor]")!;
  delete editor.dataset["gender"];
  form.dispatchEvent(new Event("photos-updated"));
  expect(editor.dataset["format"]).toBe("valid");
  editor.dataset["gender"] = "male";
  const source = form.querySelector<HTMLTextAreaElement>("#description")!;
  source.value = source.value.replace("성별: 여성", "성별: 남성");
  source.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(editor.dataset["format"]).toBe("valid"));
  const published = form.querySelector<HTMLInputElement>("#published")!;
  published.checked = true;
  const memory = form.querySelector<HTMLTextAreaElement>('[name="memorySource"]')!;
  memory.value = "";
  memory.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() =>
    expect(form.querySelector("[data-publication-status]")?.textContent).toContain("Memory"),
  );
  expect(published.disabled).toBe(false);
  published.checked = false;
  published.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(published.disabled).toBe(true));
});

test.each([
  { field: "mood", value: 55 },
  { field: "affection", value: 18 },
])(
  "$field errors are live, block publication, select the exact value, and clear after correction",
  async ({ field: name, value }) => {
    const form = workspace();
    form.querySelector<HTMLButtonElement>('[data-editor-tab="state"]')!.click();
    const field = form.querySelector<HTMLTextAreaElement>('[name="stateSource"]')!;
    const pane = form.querySelector<HTMLElement>("#pane-state")!;
    const view = EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-editor")!)!;
    const offset = field.value.indexOf(`${name}: ${value}`) + `${name}: `.length;
    view.dispatch({ changes: { from: offset, to: offset + 2, insert: "101" } });
    await vi.waitFor(() =>
      expect(pane.querySelector("[data-state-status]")?.textContent).toContain("오류"),
    );
    expect(diagnosticCount(view.state)).toBe(1);
    expect(view.contentDOM.getAttribute("aria-invalid")).toBe("true");
    expect(form.querySelector<HTMLInputElement>("#published")!.disabled).toBe(true);
    const error = pane.querySelector<HTMLButtonElement>("[data-state-issues] button")!;
    expect(error.textContent).toContain("정수 0–100");
    form.querySelector<HTMLButtonElement>('[data-editor-tab="memory"]')!.click();
    error.click();
    expect(pane.hidden).toBe(false);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      `${name}: 101`,
    );
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: initialDocs.state } });
    await vi.waitFor(() =>
      expect(pane.querySelector("[data-state-status]")?.textContent).toBe("형식 정상"),
    );
    expect(diagnosticCount(view.state)).toBe(0);
    expect(pane.querySelector("[data-state-issues]")?.children).toHaveLength(0);
    expect(pane.querySelector("[data-state-status]")?.textContent).toBe("형식 정상");
    expect(form.querySelector<HTMLInputElement>("#published")!.disabled).toBe(false);
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: initialDocs.state.replace("strength: 80", "strength: 70"),
      },
    });
    await vi.waitFor(() =>
      expect(pane.querySelector("[data-state-issues]")?.textContent).toContain("강도 80"),
    );
    const stale = pane.querySelector<HTMLButtonElement>("[data-state-issues] button")!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    stale.click();
    expect(view.state.selection.main.from).toBe(0);
  },
);
