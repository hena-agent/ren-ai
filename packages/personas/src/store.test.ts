import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createPersonaStore } from "./store.ts";
import { decodePersona } from "./model.ts";

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")),
}));

const harin = {
  id: "mira",
  name: "미라",
  bio: "그림을 그리며 파리에서 살아요.",
  imageUrl: "https://example.net/mira.png",
  published: false,
  timeZone: "Europe/Paris",
  language: "fr",
  openingLine: "Introduce yourself to the new user.",
  memory: "Remember the paintings we discussed.",
  prompt: "You are Mira, a painter in Paris.\n",
};

test("an operator can save a persona and reopen it after restarting the store", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-catalog-"));
  try {
    const directory = join(root, "personas");
    const store = await createPersonaStore(directory);
    expect(await store.list()).toEqual([]);
    await store.create(harin);
    const reopened = await createPersonaStore(directory);
    expect(await reopened.get("mira")).toEqual(harin);
    expect(await reopened.list()).toEqual([harin]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishing exposes only card fields, editing persists, and unpublishing removes the card", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-publish-"));
  try {
    const store = await createPersonaStore(root);
    await store.create(harin);
    expect(await store.publicList()).toEqual([]);
    await store.update({ ...harin, name: "미라 수정", published: true });
    expect(await store.publicList()).toStrictEqual([
      {
        id: "mira",
        name: "미라 수정",
        bio: "그림을 그리며 파리에서 살아요.",
        imageUrl: "https://example.net/mira.png",
      },
    ]);
    expect((await (await createPersonaStore(root)).get("mira")).published).toBe(true);
    await store.update({ ...harin, prompt: "바뀐 내부 프롬프트" });
    expect(await store.publicList()).toEqual([]);
    expect((await store.get("mira")).prompt).toBe("바뀐 내부 프롬프트");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid definitions fail before writing and IDs cannot traverse the persona directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-personas-"));
  try {
    const store = await createPersonaStore(root);
    for (const id of ["", "../escape", "/absolute", ".hidden", "space here", "x".repeat(65)]) {
      await expect(store.create({ ...harin, id })).rejects.toThrow(/ID는/);
      await expect(store.get(id)).rejects.toThrow(/ID는/);
      await expect(store.get(id)).rejects.toMatchObject({ kind: "invalid" });
    }
    for (const field of ["language", "openingLine", "memory", "prompt"]) {
      await expect(store.create({ ...harin, [field]: "  " })).rejects.toThrow(/must not be empty/);
    }
    await expect(store.create({ ...harin, name: " " })).rejects.toThrow(/이름/);
    await expect(store.create({ ...harin, timeZone: "No/SuchZone" })).rejects.toThrow(
      /invalid time-zone/,
    );
    for (const imageUrl of ["invalid", "javascript:alert(1)", "http://example.com/photo"]) {
      await expect(store.create({ ...harin, imageUrl })).rejects.toThrow(/Invalid URL|HTTPS/);
    }
    await expect(store.create({ ...harin, published: true, bio: "  " })).rejects.toThrow(
      /소개와 프로필 이미지/,
    );
    await expect(store.create({ ...harin, published: true, imageUrl: "" })).rejects.toThrow(
      /소개와 프로필 이미지/,
    );
    expect(() => decodePersona({ ...harin, published: "yes" })).toThrow(/published/);
    expect(() => decodePersona({ ...harin, extra: true })).toThrow(/extra/);
    expect(await store.list()).toEqual([]);
    await store.create({ ...harin, id: "X_1-" + "a".repeat(60), bio: "", imageUrl: "" });
    expect((await store.list()).length).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate creation cannot overwrite a persona and missing edits cannot create one", async () => {
  const root = await mkdtemp(join(tmpdir(), "exclusive-personas-"));
  try {
    const store = await createPersonaStore(root);
    await expect(store.get("missing")).rejects.toMatchObject({ kind: "not_found" });
    await expect(store.update(harin)).rejects.toMatchObject({ kind: "not_found" });
    await store.create(harin);
    await expect(store.create({ ...harin, name: "다른 인물" })).rejects.toMatchObject({
      kind: "conflict",
    });
    await expect(store.create({ ...harin, name: "다른 인물" })).rejects.toThrow(
      "이미 사용 중인 ID입니다.",
    );
    expect(await store.get("mira")).toEqual(harin);
    const results = await Promise.allSettled([
      store.create({ ...harin, id: "race", name: "A" }),
      store.create({ ...harin, id: "race", name: "B" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(["A", "B"]).toContain((await store.get("race")).name);
    expect(await store.list()).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a case alias cannot change the stable ID of a saved persona", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-identity-"));
  try {
    const store = await createPersonaStore(root);
    await store.create(harin);
    await expect(store.get("MIRA")).rejects.toMatchObject({
      kind: "not_found",
      message: "페르소나를 찾을 수 없습니다.",
    });
    await expect(store.update({ ...harin, id: "MIRA" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(await store.list()).toEqual([harin]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing OpenCode markdown is editable without a second metadata store", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-personas-"));
  try {
    await writeFile(
      join(root, "legacy.md"),
      "---\r\ntime-zone: Asia/Seoul\r\nlanguage: ko\r\nopening-line: Say hi\r\nmemory: Remember\r\n---\r\nA legacy prompt",
    );
    await writeFile(join(root, "notes.txt"), "not a persona");
    const store = await createPersonaStore(root);
    const legacy = await store.get("legacy");
    expect(legacy).toEqual({
      id: "legacy",
      timeZone: "Asia/Seoul",
      language: "ko",
      openingLine: "Say hi",
      memory: "Remember",
      prompt: "A legacy prompt",
      name: "legacy",
      bio: "",
      imageUrl: "",
      published: false,
    });
    await store.update({
      ...legacy,
      name: "옛 인물",
      bio: "다시 만나요",
      imageUrl: "https://example.org/legacy.jpg",
      published: true,
    });
    expect((await store.get("legacy")).prompt).toBe("A legacy prompt");
    expect(await store.list()).toHaveLength(1);
    await writeFile(
      join(root, "legacy.md"),
      "---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: Hi\nmemory: Keep\nimage-url: javascript:alert(1)\n---\nPrompt",
    );
    await expect(store.publicList()).rejects.toThrow(/HTTPS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage failures are surfaced without overwriting the previous definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-io-"));
  try {
    const store = await createPersonaStore(root);
    await mkdir(join(root, "directory.md"));
    await expect(store.get("directory")).rejects.toMatchObject({ code: "EISDIR" });
    await rm(join(root, "directory.md"), { recursive: true });
    await store.create(harin);
    vi.spyOn(files, "readFile").mockRejectedValueOnce(
      Object.assign(new Error("vanished during read"), { code: "ENOENT" }),
    );
    await expect(store.get("mira")).rejects.toMatchObject({
      kind: "not_found",
      message: "페르소나를 찾을 수 없습니다.",
    });
    vi.spyOn(files, "rename").mockRejectedValueOnce(new Error("disk offline"));
    await expect(store.update({ ...harin, name: "지워지면 안 됨" })).rejects.toThrow(
      "disk offline",
    );
    expect(await store.get("mira")).toEqual(harin);
    vi.spyOn(files, "link").mockRejectedValueOnce(new Error("link unavailable"));
    await expect(store.create({ ...harin, id: "new" })).rejects.toThrow("link unavailable");
    expect(await store.list()).toEqual([harin]);
    vi.spyOn(files, "unlink").mockRejectedValueOnce(new Error("cleanup unavailable"));
    await expect(store.create({ ...harin, id: "kept" })).rejects.toThrow("cleanup unavailable");
    expect((await store.get("kept")).name).toBe("미라");
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
