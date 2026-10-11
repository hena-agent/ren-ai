import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPersonaStore } from "./store.ts";
import { parsePersona, serializePersona } from "./model.ts";
import { parseInitialState, serializeInitialState, validateInitialDocuments } from "./initial.ts";
import { readInitialFiles } from "./initial-files.ts";

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const sample = (persona: string, file: string) =>
  readFile(new URL(`../../../docs/specs/samples/${persona}/${file}`, import.meta.url), "utf8");
const initial = async () => ({
  state: await sample("harin", "STATE.md"),
  memory: await sample("harin", "MEMORY.md"),
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "persona-initial-"));
  roots.push(root);
  const store = await createPersonaStore(root);
  const persona = parsePersona(
    "harin",
    await readFile(new URL("../catalog/harin.md", import.meta.url), "utf8"),
  );
  await store.create(persona);
  return { root, store, persona, expected: { persona: serializePersona(persona) } };
}

test("Harin and Jiwoo common state and memory samples round-trip without relationship fields", async () => {
  for (const name of ["harin", "jiwoo"]) {
    const source = await sample(name, "STATE.md");
    const state = parseInitialState(source);
    expect(parseInitialState(serializeInitialState(state))).toEqual(state);
    expect(Object.keys(state)).toEqual([
      "mood",
      "energy",
      "stress",
      "connection",
      "solitude",
      "traits",
    ]);
    expect(
      validateInitialDocuments({
        state: source.replaceAll("\n", "\r\n"),
        memory: await sample(name, "MEMORY.md"),
      }).state,
    ).toContain("\r\n");
  }
  expect(parseInitialState(await sample("harin", "STATE.md"))).toMatchObject({
    mood: 55,
    traits: { help: { strength: 80 } },
  });
  expect(parseInitialState(await sample("jiwoo", "STATE.md"))).toMatchObject({
    energy: 45,
    stress: 70,
  });
});

test("invalid YAML, fields, traits, ranges and oversized documents fail with payload-safe errors", async () => {
  const docs = await initial();
  for (const state of [
    "private payload",
    docs.state + "private payload",
    docs.state.replace("mood: 55", "mood: ["),
    docs.state.replace("mood: 55", "mood: 55\nmood: 10"),
    docs.state.replace("mood: 55", "mood: 101"),
    docs.state.replace("mood: 55", "mood: 1.5"),
    docs.state.replace("energy: 60\n", ""),
    docs.state.replace("mood: 55", "stage: stranger\nmood: 55"),
    docs.state.replace("lasting", "situational"),
    docs.state.replace("strength: 80", "strength: -1"),
    docs.state.replace("active: true", "active: yes"),
  ]) {
    expect(() => validateInitialDocuments({ ...docs, state })).toThrow(/STATE.md/);
    expect(() => parseInitialState(state)).not.toThrow(/private payload/);
  }
  for (const oversized of [
    { ...docs, state: docs.state + " ".repeat(16000) },
    { ...docs, memory: "# 현재 생활\n" + "x".repeat(16000) },
  ])
    expect(() => validateInitialDocuments(oversized)).toThrow(/16,000/);
  expect(() => validateInitialDocuments({ ...docs, memory: "# 상대와의 기억\nprivate" })).toThrow(
    /MEMORY.md/,
  );
  expect(validateInitialDocuments({ ...docs, memory: "# 현재 생활" })).toBeDefined();
});

test("saving exposes two independent Markdown files together and survives a store restart", async () => {
  const { root, store, persona, expected } = await setup();
  expect(await store.initial("harin")).toBeUndefined();
  const docs = await initial();
  await store.saveInitial("harin", docs, expected);
  expect(await readFile(join(root, "initial/harin/STATE.md"), "utf8")).toBe(docs.state);
  expect(await readFile(join(root, "initial/harin/MEMORY.md"), "utf8")).toBe(docs.memory);
  expect(await (await createPersonaStore(root)).initial("harin")).toEqual(docs);
  const updated = { ...docs, memory: "# 현재 생활\n\n- 사진을 고르는 중이다.\n" };
  await store.saveInitial("harin", updated, { ...expected, initial: docs });
  expect(await store.initial("harin")).toEqual(updated);
  expect(await store.get("harin")).toEqual(persona);
  expect(await store.list()).toEqual([persona]);
  const publicJson = JSON.stringify(await store.publicList());
  expect(publicJson).not.toContain("traits");
  expect(publicJson).not.toContain("사진을 고르는 중");
  await expect(store.initial("HARIN")).rejects.toMatchObject({ kind: "not_found" });
  await expect(store.saveInitial("../escape", docs, expected)).rejects.toMatchObject({
    kind: "invalid",
  });
});

test("stale persona/defaults and simultaneous saves cannot overwrite an approved revision", async () => {
  const { store, persona, expected } = await setup();
  const docs = await initial();
  await store.update({ ...persona, name: "바뀐 이름" });
  await expect(store.saveInitial("harin", docs, expected)).rejects.toMatchObject({
    kind: "conflict",
  });
  await store.update(persona);
  const attempts = await Promise.allSettled([
    store.saveInitial("harin", docs, expected),
    store.saveInitial("harin", docs, expected),
  ]);
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  await expect(store.saveInitial("harin", docs, expected)).rejects.toMatchObject({
    kind: "conflict",
  });
  expect(await store.initial("harin")).toEqual(docs);
});

test("staging and commit failures preserve both previous files and retain the original I/O cause", async () => {
  const { root, store, expected } = await setup();
  const docs = await initial();
  await store.saveInitial("harin", docs, expected);
  for (const method of ["writeFile", "symlink", "rename"] as const) {
    const error = Object.assign(new Error("disk unavailable"), { code: "EIO" });
    const mocked = vi.spyOn(files, method).mockRejectedValueOnce(error);
    await expect(
      store.saveInitial(
        "harin",
        { ...docs, memory: "# 현재 생활\n새 생활" },
        { ...expected, initial: docs },
      ),
    ).rejects.toBe(error);
    mocked.mockRestore();
    expect(await store.initial("harin")).toEqual(docs);
  }
  const resolve = vi
    .spyOn(files, "realpath")
    .mockRejectedValueOnce(Object.assign(new Error("read failed"), { code: "EACCES" }));
  await expect(store.initial("harin")).rejects.toMatchObject({ code: "EACCES" });
  resolve.mockRestore();
  const path = await files.realpath(join(root, "initial/harin"));
  await rm(join(path, "MEMORY.md"));
  await expect(store.initial("harin")).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(path, "MEMORY.md"), docs.memory);
  expect(await readInitialFiles(root, "harin")).toEqual(docs);
  const pointer = vi
    .spyOn(files, "readlink")
    .mockRejectedValueOnce(Object.assign(new Error("pointer denied"), { code: "EACCES" }));
  await expect(
    store.saveInitial("harin", docs, { ...expected, initial: docs }),
  ).rejects.toMatchObject({ code: "EACCES" });
  pointer.mockRestore();
  expect(await store.initial("harin")).toEqual(docs);
});
