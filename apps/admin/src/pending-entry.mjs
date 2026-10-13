import { bindPending } from "./pending.ts";
import { submitImageForm, watchImageQueue } from "./image-queue-browser.ts";
import { bindDocumentEditor } from "./document-editor-browser.ts";
for (const form of document.querySelectorAll("form")) {
  bindPending(form, submitImageForm);
  bindDocumentEditor(form);
}
watchImageQueue();
