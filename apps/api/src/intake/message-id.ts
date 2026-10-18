import { createHash } from "node:crypto";

export const promptID = (sessionID: string, guid: string) =>
  `msg_${createHash("sha256").update(sessionID).update("\0").update(guid).digest("hex")}`;
