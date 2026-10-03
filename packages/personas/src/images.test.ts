import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import { expect, test, vi } from "vitest";
import { createPersonaStore } from "./store.ts";
import { decodePersona } from "./model.ts";
vi.mock("node:crypto", async () => ({
  ...(await vi.importActual<typeof import("node:crypto")>("node:crypto")),
}));

const persona = {
  id: "harin",
  name: "하린",
  bio: "공개 소개",
  imageUrl: "",
  published: false,
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "Hello",
  memory: "Remember",
  prompt: "Private prompt",
  description: "외모·배경·말투와 비밀을 포함하는 긴 캐릭터 설명\n두 번째 문단.",
};

test("generated images survive restart, use immutable filenames and become public only when their character is published", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-images-"));
  try {
    const store = await createPersonaStore(root);
    const images = [
      {
        bytes: Buffer.from("89504e470d0a1a0a", "hex"),
        mimeType: "image/png" as const,
        extension: "png",
      },
      { bytes: Buffer.from("ffd8ffe0", "hex"), mimeType: "image/jpeg" as const, extension: "jpg" },
      {
        bytes: Buffer.from("524946460400000057454250", "hex"),
        mimeType: "image/webp" as const,
        extension: "webp",
      },
    ];
    for (const image of images) {
      const path = await store.saveImage(image);
      expect(path).toMatch(new RegExp(`^/discovery/images/[0-9a-f-]{36}\\.${image.extension}$`));
      const filename = path.split("/").at(-1)!;
      expect((await store.publicImage(filename)).status).toBe(404);
      const privateRead = await store.image(filename);
      expect(privateRead.status).toBe(200);
      expect(privateRead.headers.get("content-type")).toBe(image.mimeType);
      expect(privateRead.headers.get("x-content-type-options")).toBe("nosniff");
      expect(privateRead.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await privateRead.arrayBuffer())).toEqual(image.bytes);
      const saved = { ...persona, id: image.extension, imageUrl: path, published: true };
      await store.create(saved);
      const reopened = await createPersonaStore(root);
      expect(await reopened.get(image.extension)).toEqual(saved);
      expect((await reopened.publicImage(filename)).status).toBe(200);
      const unreferenced = await store.saveImage(image);
      expect((await reopened.publicImage(unreferenced.split("/").at(-1)!)).status).toBe(404);
      await reopened.update({ ...saved, published: false });
      expect((await reopened.publicImage(filename)).status).toBe(404);
    }
    const first = await store.saveImage(images[0]!);
    const second = await store.saveImage(images[0]!);
    expect(first).not.toBe(second);
    expect((await store.image(first.split("/").at(-1)!)).status).toBe(200);
    const filename = first.split("/").at(-1)!;
    for (const alias of [`../images/${filename}`, `${filename}/../${filename}`])
      expect((await store.image(alias)).status).toBe(404);
    expect(JSON.stringify(await store.publicList())).not.toContain(persona.description);
    const largest = Buffer.alloc(20_000_000);
    images[0]!.bytes.copy(largest);
    expect(await store.saveImage({ bytes: largest, mimeType: "image/png" })).toMatch(/\.png$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image boundaries reject mismatched formats, traversal and oversized output and report genuine storage failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "portrait-boundaries-"));
  try {
    const store = await createPersonaStore(root);
    const oversized = Buffer.alloc(20_000_001);
    Buffer.from("89504e470d0a1a0a", "hex").copy(oversized);
    for (const bytes of [
      Buffer.from("bad"),
      Buffer.from("524946460000000057454258", "hex"),
      oversized,
    ])
      await expect(store.saveImage({ bytes, mimeType: "image/png" })).rejects.toThrow("올바른 PNG");
    for (const bytes of [
      Buffer.from("bad"),
      Buffer.from("524946460000000057454258", "hex"),
      Buffer.from("000000000000000057454250", "hex"),
    ])
      await expect(store.saveImage({ bytes, mimeType: "image/webp" })).rejects.toMatchObject({
        kind: "invalid",
      });
    await expect(
      store.saveImage({ bytes: Buffer.from("ffd8ff", "hex"), mimeType: "image/png" }),
    ).rejects.toThrow("올바른 PNG");
    for (const filename of [
      "../private.md",
      "file.svg",
      "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA.png",
      "00000000-0000-0000-0000-000000000000.PNG",
      "00000000-0000-0000-0000-000000000000.png/extra",
      "00000000-0000-0000-0000-000000000000.png",
    ])
      expect((await store.image(filename)).status).toBe(404);
    await mkdir(join(root, "images"));
    const directory = "00000000-0000-0000-0000-000000000001.png";
    await mkdir(join(root, "images", directory));
    await expect(store.image(directory)).rejects.toMatchObject({ code: "EISDIR" });
    await rm(join(root, "images"), { recursive: true });
    await writeFile(join(root, "images"), "not a directory");
    await expect(
      store.saveImage({ bytes: Buffer.from("89504e470d0a1a0a", "hex"), mimeType: "image/png" }),
    ).rejects.toThrow(/EEXIST/);
    expect(() => decodePersona({ ...persona, description: " " })).toThrow(/description/);
    expect(() =>
      decodePersona({ ...persona, imageUrl: "/discovery/images/../private.png" }),
    ).toThrow(/Invalid URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a filename collision cannot overwrite an existing portrait", async () => {
  const root = await mkdtemp(join(tmpdir(), "portrait-collision-"));
  try {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("01234567-89ab-cdef-0123-456789abcdef");
    const store = await createPersonaStore(root);
    const original = Buffer.from("89504e470d0a1a0a", "hex");
    const path = await store.saveImage({ bytes: original, mimeType: "image/png" });
    await expect(
      store.saveImage({
        bytes: Buffer.concat([original, Buffer.from("new image")]),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(Buffer.from(await (await store.image(path.split("/").at(-1)!)).arrayBuffer())).toEqual(
      original,
    );
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
