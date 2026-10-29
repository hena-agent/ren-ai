import { bindPending } from "./pending.ts";
import { submitImageForm, watchImageQueue, installPage } from "./image-queue-browser.ts";
import { bindDocumentEditor } from "./document-editor-browser.ts";
import { bindUploads } from "./upload-browser.ts";
import { bindContactManagement } from "./contact-browser.ts";
for (const form of document.querySelectorAll("form")) {
  bindPending(form, submitImageForm);
  bindDocumentEditor(form);
  bindUploads(form, installPage);
}
watchImageQueue();
bindContactManagement(document);
