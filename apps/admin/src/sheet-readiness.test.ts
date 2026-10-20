import { expect, test } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { basePreview } from "../test/sub-portraits.ts";
import { bindSheetReadiness, checkSheetImages } from "./sheet-readiness.ts";

useBrowser();

function imageState(
  image: HTMLImageElement,
  complete: boolean,
  currentSrc: string,
  naturalWidth: number,
) {
  Object.defineProperties(image, {
    complete: { value: complete, configurable: true },
    currentSrc: { value: currentSrc, configurable: true },
    naturalWidth: { value: naturalWidth, configurable: true },
  });
}

test("a sheet load failure disables only same-style AI actions, including the first photo, while photo failures do not disable generation", async () => {
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  bindSheetReadiness(form);
  const anime = form.querySelector<HTMLButtonElement>("#portrait-add-anime")!;
  const photo = form.querySelector<HTMLButtonElement>("#portrait-add-photo")!;
  form.querySelector(".image-option img")!.dispatchEvent(new Event("error"));
  form.querySelector("input")!.dispatchEvent(new Event("error"));
  expect(anime.disabled).toBe(false);
  expect(photo.disabled).toBe(false);
  form.querySelector("#identity-sheet-anime img")!.dispatchEvent(new Event("error"));
  expect(anime.disabled).toBe(true);
  expect(photo.disabled).toBe(false);
  expect(form.querySelector<HTMLButtonElement>("#portrait-regenerate-anime-0")?.disabled).toBe(
    true,
  );
  expect(
    form.querySelector<HTMLButtonElement>('#identity-sheet-anime [value="sheet"]')?.disabled,
  ).toBe(false);
  expect(
    form.querySelector<HTMLElement>("#identity-sheet-anime [data-sheet-unavailable]")?.hidden,
  ).toBe(false);
  form.querySelector<HTMLElement>("#identity-sheet-photo")!.dataset["identitySheet"] =
    "unrecognized";
  form.querySelector("#identity-sheet-photo img")!.dispatchEvent(new Event("error"));
  expect(photo.disabled).toBe(false);
});

test("already failed sheet images stay blocked after polling without treating pending, healthy or source-less images as failures", async () => {
  const { page } = await basePreview();
  document.body.innerHTML = page;
  const form = document.querySelector<HTMLFormElement>("#persona-editor")!;
  const animeImage = form.querySelector<HTMLImageElement>("#identity-sheet-anime img")!;
  const photoImage = form.querySelector<HTMLImageElement>("#identity-sheet-photo img")!;
  imageState(animeImage, false, "https://example.net/loading.jpg", 0);
  imageState(photoImage, true, "https://example.net/healthy.jpg", 640);
  bindSheetReadiness(form);
  const photo = form.querySelector<HTMLButtonElement>("#portrait-add-photo")!;
  expect(photo.disabled).toBe(false);
  imageState(photoImage, true, "", 0);
  checkSheetImages(form);
  expect(photo.disabled).toBe(false);
  imageState(photoImage, true, "https://example.net/missing.jpg", 0);
  checkSheetImages(form);
  expect(photo.disabled).toBe(true);
  photo.disabled = false;
  checkSheetImages(form);
  expect(photo.disabled).toBe(true);
  expect(form.querySelector<HTMLButtonElement>("#portrait-add-anime")?.disabled).toBe(false);
});
