import { bindPending } from "./pending.ts";
import { bindDocumentEditor, destroyDocumentEditors } from "./document-editor-browser.ts";
import copy from "./copy.json";

let timer: ReturnType<typeof setTimeout> | undefined;
let revision = Symbol();
const submissions = new WeakMap<HTMLFormElement, { key: string; id: string }>();

function documentOf(markup: string) {
  return new document.defaultView!.DOMParser().parseFromString(markup, "text/html");
}

function bindPage() {
  for (const form of document.querySelectorAll("form")) {
    bindPending(form, submitImageForm);
    bindDocumentEditor(form);
  }
  watchImageQueue();
}

function replacePage(next: Document) {
  const focusId = document.activeElement?.id || "image-queue-title";
  destroyDocumentEditors();
  document.body.innerHTML = next.body.innerHTML;
  bindPage();
  (document.getElementById(focusId) ?? document.getElementById("image-queue-title"))?.focus({
    preventScroll: true,
  });
}

function installPage(next: Document) {
  if (document.querySelector("[data-image-progress]")) updatePage(next);
  else {
    replacePage(next);
    document.getElementById("image-queue-title")?.scrollIntoView({ block: "start" });
  }
}

function updatePage(next: Document) {
  const notice = next.querySelector(".notice.error");
  if (notice) {
    document.querySelector(".notice.error")?.remove();
    document.querySelector("main")!.prepend(notice);
  }
  const active = next.querySelector('[data-job-active="true"]');
  const editingPrompt = document.querySelector<HTMLDialogElement>("[data-portrait-dialog]")?.open;
  if (!next.querySelector("[data-image-progress]") || (!active && !editingPrompt)) {
    replacePage(next);
    return;
  }
  const focused = document.activeElement;
  const progress = document.querySelector("[data-image-progress]")!;
  const updated = next.querySelector("[data-image-progress]")!;
  if (progress.innerHTML !== updated.innerHTML) progress.innerHTML = updated.innerHTML;
  for (const region of document.querySelectorAll("[data-image-preview], [data-add-images]")) {
    if (editingPrompt && region.hasAttribute("data-add-images")) continue;
    const available = next.getElementById(region.id);
    if (available && region.innerHTML !== available.innerHTML)
      region.innerHTML = available.innerHTML;
  }
  if (focused?.id && !focused.isConnected)
    document.getElementById(focused.id)?.focus({ preventScroll: true });
  for (const input of document.querySelectorAll<HTMLInputElement>('[name="draft"]'))
    input.value = next.querySelector<HTMLInputElement>('[name="draft"]')!.value;
  watchImageQueue();
}

export function watchImageQueue() {
  clearTimeout(timer);
  const job =
    document.querySelector<HTMLElement>('[data-image-job][data-job-active="true"]') ??
    (document.querySelector<HTMLDialogElement>("[data-portrait-dialog]")?.open
      ? document.querySelector<HTMLElement>("[data-image-job]")
      : null);
  if (!job) return;
  const observedRevision = revision;
  timer = setTimeout(() => {
    void fetch(`/image-jobs/${encodeURIComponent(job.dataset["imageJob"]!)}`, {
      headers: { "X-Image-Queue": "1" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const markup = await response.text();
        return observedRevision === revision ? updatePage(documentOf(markup)) : undefined;
      })
      .catch(() => {
        job.querySelector("[data-queue-status]")!.textContent = copy.queueConnectionFailure;
      });
  }, 1000);
}

export function submitImageForm(form: HTMLFormElement, submitter: HTMLElement | null) {
  revision = Symbol();
  clearTimeout(timer);
  const action = submitter?.getAttribute("formaction") ?? form.action;
  const body = new FormData(form, submitter);
  const key = JSON.stringify([action, [...body.entries()].filter(([name]) => name !== "draft")]);
  const previous = submissions.get(form);
  const id = previous?.key === key ? previous.id : document.defaultView!.crypto.randomUUID();
  submissions.set(form, { key, id });
  void fetch(action, {
    method: "POST",
    headers: { "X-Image-Queue": "1", "X-Image-Request": id },
    body,
  })
    .then(async (response) => {
      if (response.ok && response.url)
        document.defaultView!.history.replaceState(null, "", response.url);
      const next = documentOf(await response.text());
      if (response.ok) document.querySelector(".notice.error")?.remove();
      submissions.delete(form);
      form.dispatchEvent(new form.ownerDocument.defaultView!.Event("image-queue-ack"));
      return next;
    })
    .then(installPage)
    .catch(() => {
      form.dispatchEvent(new form.ownerDocument.defaultView!.Event("image-queue-error"));
      form.querySelector("[data-pending]")!.textContent = copy.queueConnectionFailure;
    });
}
