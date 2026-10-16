import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as files from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { onTestFinished, expect, test, vi } from "vitest";
import { parsePersona, serializePersona } from "./model.ts";
import { createPersonaStore } from "./store.ts";
import { historyFor, readVersions, writeVersionFiles } from "./version-files.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
async function historyFixture() {
  const root = await mkdtemp(join(tmpdir(), "version-files-"));
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const persona = parsePersona(
    "harin",
    await readFile(new URL("../catalog/harin.md", import.meta.url), "utf8"),
  );
  await files.writeFile(join(root, `${persona.id}.md`), serializePersona(persona));
  return { root, persona };
}

test("history bootstraps an existing document, keeps snapshots immutable and can roll back a staged write", async () => {
  const { root, persona } = await historyFixture();
  expect(await readVersions(root, persona.id)).toEqual([]);
  expect(await historyFor(root, persona)).toMatchObject([{ version: 1, markdown: persona.prompt }]);
  const staged = await writeVersionFiles(
    root,
    { ...persona, version: 2, prompt: "Changed document." },
    persona,
  );
  expect(await readVersions(root, persona.id)).toMatchObject([
    { version: 2, markdown: "Changed document." },
    { version: 1, markdown: persona.prompt },
  ]);
  await files.writeFile(join(root, `${persona.id}.md`), serializePersona(persona));
  const store = await createPersonaStore(root);
  expect(await store.versions(persona.id)).toEqual([
    {
      version: 1,
      createdAt: (await files.stat(join(root, `${persona.id}.md`))).mtimeMs,
      restoredFrom: null,
    },
  ]);
  await expect(store.version(persona.id, 2)).rejects.toMatchObject({ kind: "not_found" });
  await expect(
    writeVersionFiles(root, { ...persona, version: 2 }, { ...persona, version: 1 }),
  ).rejects.toMatchObject({ kind: "conflict" });
  await staged.rollback();
  expect(await readVersions(root, persona.id)).toEqual([]);
});

test("history I/O failures retain their causes and clean snapshots staged before a later failure", async () => {
  const { root, persona } = await historyFixture();
  const error = Object.assign(new Error("storage offline"), { code: "EIO" });
  const readdir = vi.spyOn(files, "readdir").mockRejectedValueOnce(error);
  await expect(readVersions(root, persona.id)).rejects.toBe(error);
  readdir.mockRestore();
  const write = files.writeFile;
  const mocked = vi
    .spyOn(files, "writeFile")
    .mockImplementation((path, ...args) =>
      typeof path === "string" && path.endsWith("/2.json")
        ? Promise.reject(error)
        : write(path, ...args),
    );
  await expect(writeVersionFiles(root, { ...persona, version: 2 }, persona)).rejects.toBe(error);
  vi.spyOn(files, "unlink").mockRejectedValueOnce(new Error("history rollback denied"));
  await expect(writeVersionFiles(root, { ...persona, version: 2 }, persona)).rejects.toMatchObject({
    name: "AggregateError",
    cause: error,
  });
  mocked.mockRestore();
  vi.restoreAllMocks();
  await files.unlink(join(root, "versions", persona.id, "1.json"));
  expect(await readVersions(root, persona.id)).toEqual([]);
});
