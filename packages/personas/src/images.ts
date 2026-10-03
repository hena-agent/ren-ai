import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersonaError } from "./model.ts";

const formats = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
export interface Portrait {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
}

function contentType(bytes: Uint8Array) {
  const signature = Buffer.from(bytes.subarray(0, 12)).toString("hex");
  if (signature.startsWith("89504e470d0a1a0a")) return "image/png";
  if (signature.startsWith("ffd8ff")) return "image/jpeg";
  if (signature.startsWith("52494646") && signature.slice(16) === "57454250") return "image/webp";
  return undefined;
}

export async function saveImage(directory: string, image: Portrait) {
  if (image.bytes.byteLength > 20_000_000 || contentType(image.bytes) !== image.mimeType)
    throw new PersonaError("invalid", "올바른 PNG, JPEG 또는 WebP 이미지가 필요합니다.");
  const filename = `${randomUUID()}.${formats.get(image.mimeType)}`;
  const target = join(directory, "images");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, filename), image.bytes, { flag: "wx" });
  return `/discovery/images/${filename}`;
}

export async function imageResponse(directory: string, filename: string) {
  const match = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(png|jpg|webp)$/.exec(filename);
  if (!match) return new Response(null, { status: 404 });
  const bytes = await readFile(join(directory, "images", filename)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (!bytes) return new Response(null, { status: 404 });
  const mime = [...formats].find(([, extension]) => extension === match[1])![0];
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
