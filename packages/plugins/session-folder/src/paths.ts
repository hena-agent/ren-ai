import { basename, dirname, join } from "node:path";
import { Schema } from "effect";
import { folderID } from "./protocol.ts";

export const sessionDirectory = (root: string, id: string) =>
  join(root, "sessions", Schema.decodeUnknownSync(folderID)(id));

export const managedFolder = (root: string, directory: string) => {
  if (dirname(directory) !== join(root, "sessions")) return undefined;
  const id = basename(directory);
  return Schema.is(folderID)(id) ? id : undefined;
};
