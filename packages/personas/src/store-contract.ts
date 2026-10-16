import type { createPersonaStore } from "./store.ts";

/** The authoring boundary; filesystem and Cloudflare stores share validation. */
export type PersonaStore = Pick<
  Awaited<ReturnType<typeof createPersonaStore>>,
  | "list"
  | "get"
  | "source"
  | "initial"
  | "save"
  | "saveImage"
  | "image"
  | "publicImage"
  | "publicList"
  | "inspect"
  | "importDraft"
  | "versions"
  | "version"
>;
