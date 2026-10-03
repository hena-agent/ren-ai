export function bindPortraitDialog(form: HTMLFormElement) {
  const dialog = form.querySelector<HTMLDialogElement>("[data-portrait-dialog]");
  if (!dialog) return;
  const input = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
  let submitter: HTMLElement | null = null;
  let confirmed = false;
  form.addEventListener("submit", (event) => {
    if (event.defaultPrevented || confirmed || form.hasAttribute("aria-busy")) return;
    const intent = event.submitter?.getAttribute("value");
    if (intent !== "generate" && intent !== "portrait") return;
    event.preventDefault();
    submitter = event.submitter;
    dialog.showModal();
    input.focus();
  });
  dialog.querySelector("[data-portrait-cancel]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => submitter?.focus());
  dialog.querySelector("[data-portrait-confirm]")!.addEventListener("click", () => {
    dialog.close();
    confirmed = true;
    try {
      form.requestSubmit(submitter);
    } finally {
      confirmed = false;
    }
  });
}
