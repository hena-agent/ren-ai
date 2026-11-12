import { expect, test, vi } from "vitest";
import { fillCharacterForm, useBrowser } from "../test/browser.ts";
import { character, fixture, generator, legacy, request, seedSheets } from "../test/fixtures.ts";
import { bindPending } from "./pending.ts";
import { fluxModel, seedreamModel } from "../test/image-models.ts";
import { portraitImage } from "../test/fixtures.ts";
import { storedLayers } from "../test/artwork-layers.ts";

useBrowser();

async function editorForm(admin: Awaited<ReturnType<typeof fixture>>["admin"]) {
  document.body.innerHTML = await (await admin(request(`/personas/${legacy.id}`))).text();
  vi.stubGlobal("fetch", async (url: string) => admin(request(url)));
  const form = fillCharacterForm(character);
  bindPending(form);
  return form;
}

test("persona artwork opens the existing one-image confirmation; cancellation is free and model changes clear only its optional prompt", async () => {
  const { admin, store } = await fixture(generator);
  document.body.innerHTML = await (await admin(request("/new"))).text();
  expect(document.querySelector<HTMLButtonElement>('[value="rig-artwork"]')!.disabled).toBe(true);
  await store.create({ ...legacy, ...character, prompt: character.description });
  await seedSheets(store, legacy.id);
  const form = await editorForm(admin);
  const button = form.querySelector<HTMLButtonElement>('[value="rig-artwork"]')!;
  expect(button.disabled).toBe(false);
  const dialog = form.querySelector<HTMLDialogElement>("dialog")!;
  const count = dialog.querySelector<HTMLSelectElement>('[name="imageCount"]')!;
  const model = dialog.querySelector<HTMLInputElement>('[name="rigArtworkModel"]')!;
  const prompt = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  const submissions: FormData[] = [];
  form.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) {
      submissions.push(new FormData(form));
      event.preventDefault();
    }
  });
  // No AJAX handler is installed: the test observes confirmed submissions, not API calls.
  form.requestSubmit(button);
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(dialog.querySelector("[data-model-search]"));
  expect(dialog.querySelector("[data-portrait-target] img")!.getAttribute("src")).toContain(
    "/images/",
  );
  expect(dialog.querySelector("[data-portrait-confirm]")!.textContent).toBe("기본 몸 1장 생성");
  await vi.waitFor(() =>
    expect(
      [...dialog.querySelectorAll<HTMLInputElement>('[name="imageModelChoice"]')].some(
        (option) => option.value === seedreamModel.id,
      ),
    ).toBe(true),
  );
  dialog
    .querySelector<HTMLInputElement>(`[name="imageModelChoice"][value="${seedreamModel.id}"]`)!
    .click();
  await vi.waitFor(() =>
    expect(dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!.disabled).toBe(
      false,
    ),
  );
  expect(model.disabled).toBe(false);
  expect(dialog.querySelector("[data-image-prompt-field] label")!.textContent).toContain("기본 몸");
  expect(count.value).toBe("1");
  expect(
    [...count.options].filter((option) => !option.disabled).map((option) => option.value),
  ).toEqual(["1"]);
  prompt.value = "optional direction";
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  expect(submissions).toHaveLength(0);
  form.querySelector("[data-artwork-reference]")!.remove();
  delete button.dataset["artworkReference"];
  form.requestSubmit(button);
  expect(dialog.querySelector("[data-portrait-target] img")).toBeNull();
  dialog
    .querySelector<HTMLInputElement>(`[name="imageModelChoice"][value="${fluxModel.id}"]`)!
    .click();
  expect(prompt.value).toBe("");
  await vi.waitFor(() =>
    expect(dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!.disabled).toBe(
      false,
    ),
  );
  prompt.value = "gentle smile";
  dialog.querySelector<HTMLButtonElement>("[data-portrait-confirm]")!.click();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]!.get("rigArtworkModel")).toBe(fluxModel.id);
  expect(submissions[0]!.get("portraitInstructions")).toBe("gentle smile");
});

test("outfit options reference the body and reset prompts when switching between body and clothing", async () => {
  const { store, admin } = await fixture(generator);
  await store.create({ ...legacy, ...character, prompt: character.description });
  await seedSheets(store, legacy.id);
  const imageUrl = await store.saveImage(portraitImage);
  await store.saveRigArtwork(legacy.id, {
    kind: "body",
    model: seedreamModel.id,
    imageUrl,
    operationId: "body",
    layers: {
      ...storedLayers(imageUrl, "body"),
      layers: storedLayers(imageUrl, "body").layers.map((layer) => ({
        ...layer,
        plane: "face" as const,
      })),
    },
  });
  const form = await editorForm(admin);
  const outfit = form.querySelector<HTMLButtonElement>(
    '[value="rig-artwork"][data-artwork-target="outfit"]',
  )!;
  const body = form.querySelector<HTMLButtonElement>(
    '[value="rig-artwork"][data-artwork-target="body"]',
  )!;
  const dialog = form.querySelector<HTMLDialogElement>("[data-portrait-dialog]")!;
  expect(outfit.disabled).toBe(false);
  form.requestSubmit(outfit);
  expect(dialog.querySelector("h2")!.textContent).toBe("의상만 생성");
  expect(dialog.querySelector("[data-portrait-target] img")!.getAttribute("src")).toBe(imageUrl);
  expect(dialog.querySelector<HTMLInputElement>('[name="rigArtworkTarget"]')!.value).toBe("outfit");
  const prompt = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  prompt.value = "dress only";
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  form.requestSubmit(body);
  expect(prompt.value).toBe("");
  expect(dialog.querySelector<HTMLInputElement>('[name="rigArtworkTarget"]')!.value).toBe("body");
  expect(dialog.querySelector("h2")!.textContent).toBe("속옷 차림 기본 몸 생성");
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  const face = form.querySelector<HTMLButtonElement>('[data-rig-face-action="closed"]')!;
  form.requestSubmit(face);
  expect(dialog.querySelector("h2")!.textContent).toBe("현재 얼굴·표정 편집");
  expect(new FormData(form).get("rigFaceAction")).toBe("closed");
  prompt.value = "soft smile";
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  form.requestSubmit(form.querySelector<HTMLButtonElement>('[data-rig-face-action="surprised"]'));
  expect(prompt.value).toBe("");
  expect(new FormData(form).get("rigFaceAction")).toBe("surprised");
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
  form.requestSubmit(body);
  expect(new FormData(form).get("rigFaceAction")).toBeNull();
  dialog.querySelector<HTMLButtonElement>("[data-portrait-cancel]")!.click();
});
