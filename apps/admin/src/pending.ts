import { bindPortraitDialog } from "./portrait-dialog.ts";
import { syncGender } from "./editor-controls.ts";
import { bindSheetReadiness } from "./sheet-readiness.ts";
const messages: Readonly<Record<string, string>> = {
  generate: "adding",
  regenerate: "regenerating",
  "retry-image": "regenerating",
  save: "saving",
};

export function bindPending(
  form: HTMLFormElement,
  submitImage?: (form: HTMLFormElement, submitter: HTMLElement | null) => void,
) {
  bindPortraitDialog(form);
  bindSheetReadiness(form);
  let pending = false;
  const status = form.querySelector<HTMLOutputElement>("[data-pending]");
  const improvement = form.querySelector<HTMLOutputElement>("[data-improvement-pending]");
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    if (pending) {
      event.preventDefault();
      return;
    }
    const confirmation = event.submitter?.getAttribute("data-confirm-delete");
    if (confirmation && !form.ownerDocument.defaultView!.confirm(confirmation)) {
      event.preventDefault();
      return;
    }
    pending = true;
    syncGender(form);
    form.setAttribute("aria-busy", "true");
    const intent = event.submitter?.getAttribute("value");
    if (improvement && intent === "improve") improvement.textContent = "초안을 개선하고 있습니다…";
    if (
      submitImage &&
      ["generate", "regenerate", "retry-image", "sheet", "sheets"].includes(String(intent))
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
    if (improvement) improvement.textContent = "";
  };
  form.ownerDocument.defaultView!.addEventListener("pageshow", reset);
  form.addEventListener("image-queue-error", reset);
  form.addEventListener("image-queue-ack", reset);
}
