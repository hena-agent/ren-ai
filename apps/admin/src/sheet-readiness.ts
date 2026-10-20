function unavailable(image: HTMLImageElement, form: HTMLFormElement) {
  const region = image.closest<HTMLElement>("[data-identity-sheet]");
  const style = region?.dataset["identitySheet"];
  if (style !== "anime" && style !== "photo") return;
  for (const button of form.querySelectorAll<HTMLButtonElement>(
    `button[data-portrait-style="${style}"][value="generate"], button[data-portrait-style="${style}"][value="regenerate"]`,
  ))
    button.disabled = true;
  region!.querySelector<HTMLElement>("[data-sheet-unavailable]")!.hidden = false;
}

export function checkSheetImages(form: HTMLFormElement) {
  for (const image of form.querySelectorAll<HTMLImageElement>("[data-identity-sheet] img"))
    if (image.complete && image.currentSrc && image.naturalWidth === 0) unavailable(image, form);
}

export function bindSheetReadiness(form: HTMLFormElement) {
  form.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof form.ownerDocument.defaultView!.HTMLImageElement)
        unavailable(event.target, form);
    },
    true,
  );
  checkSheetImages(form);
}
