import { mkdtemp, rm } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { sheet } from "../../../apps/admin/test/sheet.ts";
import { renderCharacterSheet } from "./character-sheet.ts";
import { publicationIssues, initialTraits, checkInitialPersona } from "./publication.ts";
import { serializeInitialState, validateInitialMemory } from "./initial.ts";
import { createPersonaStore } from "./store.ts";
import { serializePersona, decodePersona } from "./model.ts";
import { withPublicProfile } from "./profile.ts";

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")),
}));
const source = withPublicProfile(renderCharacterSheet(sheet), "천천히 알아가요.");
const persona = decodePersona({
  id: "harin",
  name: sheet.name,
  gender: sheet.gender,
  prompt: source,
  bio: "",
  published: false,
  imageUrl: "https://example.net/photo.png",
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "인사",
  memory: "기억 지침",
});
const documents = {
  state: serializeInitialState({
    mood: 60,
    energy: 40,
    stress: 50,
    connection: 30,
    solitude: 65,
    affection: 18,
    traits: initialTraits(source),
  }),
  memory: "# 현재 생활\n\n- 인화 작업을 준비하고 있다.\n",
};

test("publication validates real document content, metadata identity, traits and meaningful memory", () => {
  expect(publicationIssues(persona, documents)).toEqual([]);
  const { gender, ...unspecified } = persona;
  expect(publicationIssues(unspecified, documents)).toEqual([]);
  expect(gender).toBe("female");
  for (const changed of [
    { ...persona, name: "다른 이름" },
    { ...persona, gender: "male" as const },
    { ...persona, prompt: "bad", description: "bad" },
    { ...persona, imageUrl: "" },
  ])
    expect(publicationIssues(changed, documents).some((issue) => issue.tab === "persona")).toBe(
      true,
    );
  expect(publicationIssues(persona).map((issue) => issue.tab)).toEqual(["state", "memory"]);
  for (const state of [
    "",
    documents.state.replace("80", "79"),
    documents.state.replace("도움 요청 회피", "다른 특성"),
    documents.state + " ".repeat(16000),
  ])
    expect(
      publicationIssues(persona, { ...documents, state }).some((issue) => issue.tab === "state"),
    ).toBe(true);
  for (const memory of [
    "",
    "# 현재 생활",
    "## 현재 생활\n내용",
    "# 다른 제목\n내용",
    "# 현재 생활\n\n```text\n코드뿐\n```",
    "# 현재 생활\n- ",
    "x".repeat(16001),
  ])
    expect(
      publicationIssues(persona, { ...documents, memory }).some((issue) => issue.tab === "memory"),
    ).toBe(true);
  expect(validateInitialMemory("# 현재 생활\n\n현재 진행 중인 생활은 없다.")).toContain("없다");
  expect(checkInitialPersona(documents, source)).toBe(documents);
  expect(() =>
    checkInitialPersona({ ...documents, state: documents.state.replace("80", "79") }, source),
  ).toThrow(/특성 이름/);
});

test("bundle saves roll back initial pointers on persona commit failure and keep private incomplete drafts editable", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-bundle-"));
  try {
    const store = await createPersonaStore(root);
    const original = { state: "작성 중인 상태", memory: "작성 중인 기억" };
    await store.save(persona, original, { persona: "" });
    const baseline = serializePersona(await store.get(persona.id));
    await expect(
      store.save({ ...persona, published: true }, original, {
        persona: baseline,
        initial: original,
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    const rename = files.rename;
    const failure = vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
      if (String(to) === join(root, "harin.md"))
        throw Object.assign(new Error("commit failed"), { code: "EIO" });
      return rename(from, to);
    });
    await expect(
      store.save({ ...persona, published: true }, documents, {
        persona: baseline,
        initial: original,
      }),
    ).rejects.toMatchObject({ code: "EIO" });
    failure.mockRestore();
    expect(await store.initial(persona.id)).toEqual(original);
    expect((await store.get(persona.id)).published).toBe(false);
    await store.save({ ...persona, published: true }, documents, {
      persona: baseline,
      initial: original,
    });
    expect(await store.publicList()).toHaveLength(1);
    await expect(
      store.save(persona, documents, { persona: baseline, initial: documents }),
    ).rejects.toMatchObject({ kind: "conflict" });
    await expect(
      store.save(persona, documents, { persona: serializePersona(await store.get(persona.id)) }),
    ).rejects.toMatchObject({ kind: "conflict" });
    const cause = Object.assign(new Error("source commit failed"), { code: "EIO" });
    let installs = 0;
    const rollbackFailure = vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
      if (String(to) === join(root, "harin.md")) throw cause;
      if (String(to) === join(root, "initial", "harin") && ++installs > 1)
        throw new Error("rollback failed");
      return rename(from, to);
    });
    await expect(
      store.save(persona, documents, {
        persona: serializePersona(await store.get(persona.id)),
        initial: documents,
      }),
    ).rejects.toMatchObject({ cause });
    rollbackFailure.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed creation leaves neither a persona nor an initial pointer and concurrent saves have one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-bundle-create-"));
  try {
    const store = await createPersonaStore(root);
    const failed = vi.spyOn(files, "link").mockRejectedValueOnce(new Error("failed creation"));
    await expect(store.save(persona, documents, { persona: "" })).rejects.toThrow(
      "failed creation",
    );
    failed.mockRestore();
    expect(await store.list()).toEqual([]);
    const results = await Promise.allSettled([
      store.save(persona, documents, { persona: "" }),
      store.save(persona, documents, { persona: "" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.initial(persona.id)).toEqual(documents);
    await expect(
      store.save({ ...persona, id: "../bad" }, documents, { persona: "" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      store.save(
        persona,
        { ...documents, memory: "x".repeat(16001) },
        { persona: serializePersona(await store.get(persona.id)), initial: documents },
      ),
    ).rejects.toThrow(/size limit/);
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
