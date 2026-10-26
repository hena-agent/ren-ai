import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Decode at the authenticated send boundary; never accept a caller-supplied path or URL. */
export function outgoingPhoto(directory: string, base64: string, attemptID: string) {
  if (base64.length > 13_333_336) throw new Error("A JPEG of at most 10 MB is required");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length > 10_000_000 ||
    bytes.length < 5 ||
    bytes.toString("base64") !== base64 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    throw new Error("A JPEG of at most 10 MB is required");
  const path = join(
    directory,
    `${createHash("sha256").update(attemptID.toUpperCase()).update(bytes).digest("hex")}.jpg`,
  );
  return {
    detail: { attachments: [{ path, mimeType: "image/jpeg", uti: "public.jpeg", missing: false }] },
    path,
    save() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(path, bytes, { mode: 0o600, flag: "wx", flush: true });
    },
  };
}
