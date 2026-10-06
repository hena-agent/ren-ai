import { imageSlots } from "./image-slots.ts";
import copy from "./copy.json";

export function updatePromptFields(dialog: HTMLDialogElement) {
  const list = dialog.querySelector<HTMLElement>("[data-image-prompt-list]");
  if (!list) return;
  const count = Number(dialog.querySelector<HTMLSelectElement>('[name="imageCount"]')!.value);
  const intent = dialog.dataset["imageIntent"]!;
  const style = dialog.dataset["imageStyle"] === "anime" ? "anime" : "photo";
  const slots = imageSlots(intent, count, style, Number(dialog.dataset["imageIndex"]));
  const prototype = list.querySelector<HTMLElement>("[data-image-prompt-field]")!;
  while (list.children.length < slots.length) {
    const field = dialog.ownerDocument.createElement("div");
    field.toggleAttribute("data-image-prompt-field");
    field.innerHTML = prototype.innerHTML;
    const input = field.querySelector("textarea")!;
    const id = `image-prompt-${list.children.length}`;
    input.id = id;
    input.value = "";
    field.querySelector("label")!.htmlFor = id;
    list.append(field);
  }
  for (const [index, field] of [...list.children].entries()) {
    const input = field.querySelector("textarea")!;
    const slot = slots[index];
    input.disabled = !slot;
    if (index === 0) input.name = "portraitInstructions";
    else if (slot) input.name = "imagePrompts";
    else input.removeAttribute("name");
    field.toggleAttribute("hidden", !slot);
    if (slot)
      field.querySelector("label")!.textContent =
        `${copy.portraitLabels[slot.style]} 사진 ${slot.index + 1} · ${copy.portraitInstructionsLabel}`;
  }
  dialog.querySelector<HTMLInputElement>("[data-separate-image-prompts]")!.value = "1";
}
