import { configureImageCount } from "./portrait-count-options.ts";

export function bindPortraitDialog(form: HTMLFormElement) {
  const dialog = form.querySelector<HTMLDialogElement>("[data-portrait-dialog]");
  if (!dialog) return;
  const input = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  let submitter: HTMLElement | null = null;
  let confirmed = false;
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented || confirmed || form.hasAttribute("aria-busy")) return;
    const intent = event.submitter?.getAttribute("value");
    if (
      !intent ||
      !["generate", "portrait", "subportrait", "regenerate", "retry-image"].includes(intent)
    )
      return;
    event.preventDefault();
    submitter = event.submitter;
    const key = submitter!.getAttribute("data-portrait-operation") ?? intent;
    if (input.dataset["portraitOperation"] !== key) {
      for (const prompt of dialog.querySelectorAll("textarea")) prompt.value = "";
      input.value = submitter!.getAttribute("data-portrait-prompt") ?? "";
      const count = dialog.querySelector<HTMLSelectElement>('[name="imageCount"]');
      if (count) count.value = "1";
    }
    input.dataset["portraitOperation"] = key;
    const target = dialog.querySelector("[data-portrait-target]");
    if (target) target.textContent = submitter!.getAttribute("data-portrait-label");
    configureImageCount(dialog, submitter!, intent);
    dialog.showModal();
    input.focus();
  });
  dialog.querySelector("[data-portrait-cancel]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => submitter?.focus());
  dialog.querySelector("[data-portrait-confirm]")!.addEventListener("click", () => {
    dialog.close();
    confirmed = true;
    const target = form.ownerDocument.createElement("button");
    for (const attribute of submitter!.attributes)
      target.setAttribute(attribute.name, attribute.value);
    target.hidden = true;
    form.append(target);
    try {
      form.requestSubmit(target);
    } finally {
      target.remove();
      confirmed = false;
    }
  });
}
