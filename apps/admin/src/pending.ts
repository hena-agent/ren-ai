import { bindPortraitDialog } from "./portrait-dialog.ts";

export function bindPending(form: HTMLFormElement) {
  bindPortraitDialog(form);
  let pending = false;
  const status = form.querySelector<HTMLOutputElement>("[data-pending]");
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    if (pending) {
      event.preventDefault();
      return;
    }
    pending = true;
    form.setAttribute("aria-busy", "true");
    if (status)
      status.textContent =
        event.submitter?.getAttribute("value") === "save"
          ? (form.dataset["saving"] ?? "")
          : (form.dataset["generating"] ?? "");
  });
  form.ownerDocument.defaultView!.addEventListener("pageshow", () => {
    pending = false;
    form.removeAttribute("aria-busy");
    if (status) status.textContent = "";
  });
}
