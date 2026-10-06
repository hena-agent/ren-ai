import { bindPortraitDialog } from "./portrait-dialog.ts";
import { syncGender, bindProfileSource } from "./editor-controls.ts";
const messages: Readonly<Record<string, string>> = {
  subportrait: "adding",
  regenerate: "regenerating",
  "retry-image": "regenerating",
  save: "saving",
};

export function bindPending(
  form: HTMLFormElement,
  submitImage?: (form: HTMLFormElement, submitter: HTMLElement | null) => void,
) {
  bindPortraitDialog(form);
  bindProfileSource(form);
  let pending = false;
  const status = form.querySelector<HTMLOutputElement>("[data-pending]");
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    if (pending) {
      event.preventDefault();
      return;
    }
    pending = true;
    syncGender(form);
    form.setAttribute("aria-busy", "true");
    const intent = event.submitter?.getAttribute("value");
    if (
      submitImage &&
      ["generate", "portrait", "subportrait", "regenerate", "retry-image"].includes(String(intent))
    ) {
      event.preventDefault();
      submitImage(form, event.submitter);
    }
    if (status) {
      status.textContent = form.dataset[messages[String(intent)] ?? "generating"] ?? "";
    }
  });
  const reset = () => {
    pending = false;
    form.removeAttribute("aria-busy");
    if (status) status.textContent = "";
  };
  form.ownerDocument.defaultView!.addEventListener("pageshow", reset);
  form.addEventListener("image-queue-error", reset);
  form.addEventListener("image-queue-ack", reset);
}
