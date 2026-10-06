function updateTotal(select: HTMLSelectElement) {
  const total = select.closest("dialog")!.querySelector("[data-image-total]");
  if (!total) return;
  const count = Number(select.value);
  total.textContent =
    select.dataset["imageIntent"] === "generate" || select.dataset["imageIntent"] === "portrait"
      ? `애니메·실사 각각 ${count}장 · 총 ${count * 2}장 생성`
      : `선택한 스타일 ${count}장 생성`;
}

function changed(this: HTMLSelectElement) {
  updateTotal(this);
  updatePromptFields(this.closest("dialog")!);
}

export function configureImageCount(
  dialog: HTMLDialogElement,
  submitter: HTMLElement,
  intent: string,
) {
  const select = dialog.querySelector<HTMLSelectElement>('[name="imageCount"]');
  if (!select) return;
  const maximum =
    intent === "regenerate" || intent === "retry-image"
      ? 1
      : Number(submitter.dataset["imageMaximum"] ?? 6);
  if (Number(select.value) > maximum) select.value = "1";
  for (const option of select.options) option.disabled = Number(option.value) > maximum;
  select.dataset["imageIntent"] = intent;
  dialog.dataset["imageIntent"] = intent;
  dialog.dataset["imageStyle"] = submitter.dataset["portraitStyle"];
  dialog.dataset["imageIndex"] = String(Number(submitter.dataset["imageIndex"] ?? 0));
  select.addEventListener("change", changed);
  updateTotal(select);
  updatePromptFields(dialog);
}
import { updatePromptFields } from "./image-prompt-fields.ts";
