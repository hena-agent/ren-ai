import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SocialImageData } from "@ren-ai/onboarding/social-images";

export async function withImageUpload<T>(
  home: string,
  image: SocialImageData,
  upload: (path: string) => Promise<T>,
) {
  const bytes = Buffer.from(image.data, "base64");
  if (
    bytes.length < 5 ||
    bytes.length > 10000000 ||
    bytes.toString("base64") !== image.data ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  )
    throw new Error("Invalid social image JPEG");
  const root = join(home, "uploads");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "image-"));
  try {
    const file = join(directory, "image.jpg");
    await writeFile(file, bytes, { mode: 0o600 });
    return await upload(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
