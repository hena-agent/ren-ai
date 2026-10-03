import { afterEach, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import type { HTMLTextAreaElement } from "happy-dom";
import { serializePersona } from "@ren-ai/personas";
import {
  character,
  fixture,
  generator,
  introduction,
  legacy,
  newToken,
  portraitReply,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { draftTokens } from "./draft.ts";
import { createProfileGenerator } from "./generation.ts";
import copy from "./copy.json";
import policy from "./policy.json";

afterEach(() => vi.restoreAllMocks());
const instructions =
  "노을빛 공방에서 베이지색 니트를 입고 웃는 모습.\n<script>private direction</script>";
const profilePreview = async (admin: ReturnType<typeof createAdmin>, source = character) =>
  (
    await admin(
      request("/personas", { ...source, draft: await newToken(admin), intent: "generate" }),
    )
  ).text();

test("a closed prompt dialog supports first generation and regeneration without changing the persona source", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const intro = vi.fn<typeof generator.introduction>().mockImplementation(generator.introduction);
  const { admin, store } = await fixture({ ...generator, portrait, introduction: intro });
  const initial = await (await admin(request("/new"))).text();
  expect(initial).toContain("data-portrait-dialog");
  const generated = await (
    await admin(
      request("/personas", {
        ...character,
        draft: tokenOf(initial),
        intent: "generate",
        portraitInstructions: instructions,
      }),
    )
  ).text();
  const window = new Window();
  try {
    window.document.write(generated);
    const input = window.document.querySelector<HTMLTextAreaElement>(
      '[name="portraitInstructions"]',
    )!;
    expect(input.id).toBe("portrait-instructions");
    expect(input.value).toBe(instructions);
    expect(input.required).toBe(false);
    expect(input.getAttribute("rows")).toBe("5");
    expect(input.placeholder).toBe(copy.portraitInstructionsPlaceholder);
    expect(input.getAttribute("aria-describedby")).toBe("portrait-instructions-hint");
    expect(window.document.querySelector('label[for="portrait-instructions"]')?.textContent).toBe(
      copy.portraitInstructionsLabel,
    );
    expect(window.document.getElementById("portrait-instructions-hint")?.textContent).toBe(
      copy.portraitInstructionsHint,
    );
    expect(input.closest("form")?.id).toBe("persona-editor");
    const dialog = input.closest("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(dialog.getAttribute("aria-labelledby")).toBe("portrait-dialog-title");
    expect(dialog.getAttribute("aria-describedby")).toBe("portrait-instructions-hint");
    expect(window.document.getElementById("portrait-dialog-title")?.textContent).toBe(
      copy.portraitDialogTitle,
    );
    expect(dialog.querySelector("[data-portrait-cancel]")?.textContent).toBe(
      copy.portraitDialogCancel,
    );
    expect(dialog.querySelector("[data-portrait-confirm]")?.textContent).toBe(
      copy.portraitDialogConfirm,
    );
    expect(dialog.querySelector("[data-portrait-confirm]")?.getAttribute("type")).toBe("button");
    expect(dialog.querySelector("[data-portrait-cancel]")?.getAttribute("type")).toBe("button");
    expect(portrait.mock.calls).toEqual([
      [character, "anime", instructions],
      [character, "photo", instructions],
    ]);
    expect(intro).toHaveBeenCalledWith(character);
    expect(window.document.querySelector('[name="intent"][value="portrait"]')).toBeNull();
    expect(window.document.querySelectorAll(".generation-actions button")).toHaveLength(1);
    expect(window.document.querySelector(".generation-actions button")?.textContent).toBe(
      copy.regenerate,
    );
    portrait.mockClear();
    const response = await admin(
      request("/personas", {
        ...character,
        draft: tokenOf(generated),
        intent: "portrait",
        portraitInstructions: `  ${instructions}  `,
      }),
    );
    expect(response.status).toBe(200);
    const page = await response.text();
    window.document.body.innerHTML = page;
    expect(
      window.document.querySelector<HTMLTextAreaElement>('[name="portraitInstructions"]')?.value,
    ).toBe(instructions);
    expect(page).not.toContain("<script>private direction</script>");
    expect(portrait.mock.calls).toEqual([
      [character, "anime", instructions],
      [character, "photo", instructions],
    ]);
    expect(intro).toHaveBeenCalledTimes(1);
    expect(page).toContain(introduction);
    expect(draftTokens("test-password").decode(tokenOf(page)).portraitInstructions).toBe(
      instructions,
    );
    expect(await store.list()).toEqual([]);
    const saved = await admin(
      request("/personas", {
        ...character,
        draft: tokenOf(page),
        portraitInstructions: instructions,
        published: "on",
      }),
    );
    expect(saved.status).toBe(303);
    const record = (await store.list())[0]!;
    expect(record.description).toBe(character.description);
    expect(record.bio).toBe(introduction);
    expect(serializePersona(record)).not.toContain("private direction");
    expect(JSON.stringify(await store.publicList())).not.toContain("portraitInstructions");
    const reloaded = await (await admin(request(`/personas/${record.id}`))).text();
    expect(reloaded).not.toContain("private direction");
  } finally {
    await window.happyDOM.close();
  }
});

test("failed regeneration retains the extra instructions and old images, while retries can clear them", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const { admin, store, logs } = await fixture({ ...generator, portrait });
  const generated = await profilePreview(admin);
  const previous = draftTokens("test-password").decode(tokenOf(generated)).preview;
  portrait.mockRejectedValueOnce(new Error(`generation failed: ${instructions}`));
  const failed = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(generated),
      intent: "portrait",
      portraitInstructions: instructions,
    }),
  );
  expect(failed.status).toBe(503);
  const page = await failed.text();
  const draft = draftTokens("test-password").decode(tokenOf(page));
  expect(draft.preview).toBe(previous);
  expect(draft.portraitInstructions).toBe(instructions);
  expect(page).toContain("&lt;script&gt;private direction&lt;/script&gt;");
  expect(JSON.stringify(logs)).not.toContain("private direction");
  expect(logs.find((entry) => entry.event === "operation.failed")?.error?.message).toBe(
    "generation failed: <REDACTED>",
  );
  const unconfigured = createAdmin(store, "test-password", "", {
    log: (entry) => logs.push(entry),
  });
  const missing = await unconfigured(
    request("/personas", {
      ...character,
      draft: tokenOf(page),
      intent: "portrait",
      portraitInstructions: instructions,
    }),
  );
  expect(missing.status).toBe(503);
  expect(
    draftTokens("test-password").decode(tokenOf(await missing.text())).portraitInstructions,
  ).toBe(instructions);
  portrait.mockClear();
  const retried = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(page),
      intent: "portrait",
      portraitInstructions: "   ",
    }),
  );
  expect(retried.status).toBe(200);
  expect(portrait.mock.calls).toEqual([
    [character, "anime"],
    [character, "photo"],
  ]);
  expect(
    draftTokens("test-password").decode(tokenOf(await retried.text())).portraitInstructions,
  ).toBe("");
  portrait.mockClear();
  const full = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(page),
      intent: "generate",
      portraitInstructions: "new private direction",
    }),
  );
  expect(full.status).toBe(200);
  expect(draftTokens("test-password").decode(tokenOf(await full.text())).portraitInstructions).toBe(
    "new private direction",
  );
  expect(portrait.mock.calls).toEqual([
    [character, "anime", "new private direction"],
    [character, "photo", "new private direction"],
  ]);
});

test("old forms can omit extra instructions and uploaded files cannot become image prompts", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const { admin } = await fixture({ ...generator, portrait });
  const source = { ...character, description: "차분한 도예가" };
  const generated = await profilePreview(admin, source);
  portrait.mockClear();
  const response = await admin(
    request("/personas", { ...source, draft: tokenOf(generated), intent: "portrait" }),
  );
  expect(response.status).toBe(200);
  expect(portrait.mock.calls).toEqual([
    [source, "anime"],
    [source, "photo"],
  ]);
  const form = new FormData();
  for (const [field, value] of Object.entries({
    ...source,
    draft: tokenOf(generated),
    intent: "portrait",
  }))
    form.set(field, value);
  form.set("portraitInstructions", new File(["not text"], "instructions.txt"));
  const upload = request("/personas");
  const rejected = await admin(new Request(upload, { method: "POST", body: form }));
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain(copy.formError);
  expect(portrait).toHaveBeenCalledTimes(2);
  form.set("intent", "save");
  const saved = await admin(new Request(request("/personas"), { method: "POST", body: form }));
  expect(saved.status).toBe(303);
});

test("one action preserves the introduction until the name or description changes", async () => {
  const introductionModel = vi
    .fn<typeof generator.introduction>()
    .mockImplementation(generator.introduction);
  const { admin } = await fixture({ ...generator, introduction: introductionModel });
  let page = await profilePreview(admin);
  expect(introductionModel).toHaveBeenCalledTimes(1);
  for (const [fields, count] of [
    [{ ...character, portraitInstructions: "새 의상" }, 1],
    [{ ...character, name: "새 이름" }, 2],
    [{ ...character, name: "새 이름", description: "새로운 캐릭터 설명" }, 3],
  ] satisfies [Record<string, string>, number][]) {
    const response = await admin(
      request("/personas", { ...fields, draft: tokenOf(page), intent: "generate" }),
    );
    expect(response.status).toBe(200);
    page = await response.text();
    expect(introductionModel).toHaveBeenCalledTimes(count);
    expect(page).toContain(introduction);
  }
});

test("incomplete legacy profiles regenerate their introduction even when the character is unchanged", async () => {
  const introductionModel = vi
    .fn<typeof generator.introduction>()
    .mockImplementation(generator.introduction);
  const { admin, store } = await fixture({ ...generator, introduction: introductionModel });
  await store.create(legacy);
  for (const profile of [
    { bio: "", imageUrl: legacy.imageUrl },
    { bio: legacy.bio, imageUrl: "" },
  ]) {
    await store.update({ ...legacy, ...profile });
    const page = await (await admin(request("/personas/legacy"))).text();
    expect(page).toContain(copy.generate);
    expect(page).not.toContain(copy.regenerate);
    const response = await admin(
      request("/personas/legacy", {
        name: legacy.name,
        description: legacy.prompt,
        draft: tokenOf(page),
        intent: "generate",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(introduction);
  }
  expect(introductionModel).toHaveBeenCalledTimes(2);
  await store.update({ ...legacy, imageUrl: "" });
  introductionModel.mockClear();
  const legacyPage = await (await admin(request("/personas/legacy"))).text();
  const imageOnly = await admin(
    request("/personas/legacy", {
      name: legacy.name,
      description: legacy.prompt,
      draft: tokenOf(legacyPage),
      intent: "portrait",
    }),
  );
  expect(imageOnly.status).toBe(200);
  expect(await imageOnly.text()).toContain(legacy.bio);
  expect(introductionModel).not.toHaveBeenCalled();
});

test("Gemini receives extra image instructions after the unchanged character and art direction", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(portraitReply);
  const model = createProfileGenerator({ key: "key", fetcher });
  for (const style of ["anime", "photo"] satisfies ("anime" | "photo")[]) {
    await model.portrait(character, style, instructions);
    const body = await new Request(...fetcher.mock.calls.at(-1)!).text();
    const expected = `${policy.portraits[style]}\n\n${character.name}\n${character.description}\n\nADDITIONAL PORTRAIT INSTRUCTIONS:\n${instructions}`;
    expect(body).toContain(JSON.stringify(expected));
  }
  await model.portrait(character, "photo");
  const plain = await new Request(...fetcher.mock.calls.at(-1)!).text();
  expect(plain).not.toContain("ADDITIONAL PORTRAIT INSTRUCTIONS");
  expect(plain).not.toContain("private direction");
});

test("partial legacy profiles still offer a prompt dialog for full generation", async () => {
  const { admin, store } = await fixture();
  await store.create({ ...legacy, bio: "" });
  const page = await (await admin(request("/personas/legacy"))).text();
  expect(page).toContain('name="portraitInstructions"');
  expect(page).not.toContain('value="portrait"');
});
