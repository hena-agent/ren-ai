import { Buffer } from "node:buffer";
import { Effect } from "effect";
import { validatePortrait } from "@ren-ai/personas";

export interface PhotoBucket {
  get: (key: string) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put: (key: string, value: Uint8Array) => Promise<object | null>;
  delete: (key: string) => Promise<void>;
}

export const photoKey = (id: string) => `conversation-photos/${id}.jpg`;

export function jpeg(bytes: Uint8Array) {
  validatePortrait({ bytes, mimeType: "image/jpeg" });
  if (bytes.byteLength < 5 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
    throw new Error("Invalid Conversation JPEG framing");
  if (bytes.byteLength > 10_000_000) throw new Error("Conversation photo exceeds maximum size");
  return Buffer.from(bytes).toString("base64");
}

export const photoData = (bucket: PhotoBucket, id: string) =>
  Effect.tryPromise(async () => {
    const object = await bucket.get(photoKey(id));
    return object ? jpeg(new Uint8Array(await object.arrayBuffer())) : undefined;
  });
