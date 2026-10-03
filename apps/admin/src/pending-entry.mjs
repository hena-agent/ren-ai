import { bindPending } from "./pending.ts";
for (const form of document.querySelectorAll("form")) bindPending(form);
