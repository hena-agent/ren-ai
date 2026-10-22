import { basename, dirname, join } from "node:path";
import { Schema } from "effect";
import { folderID, personaID } from "./protocol.ts";

export const sessionDirectory = (root: string, id: string) =>
  join(root, "sandboxes", Schema.decodeUnknownSync(folderID)(id));

export const personaDirectory = (root: string, id: string) =>
  join(root, "personas", Schema.decodeUnknownSync(personaID)(id));

export const managedFolder = (root: string, directory: string) => {
  const id = basename(directory);
  if (dirname(directory) === join(root, "personas"))
    return Schema.is(personaID)(id) ? id : undefined;
  if (dirname(directory) === join(root, "sandboxes"))
    return Schema.is(folderID)(id) ? id : undefined;
  return undefined;
};
