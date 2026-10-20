import { expect, test } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identitySheetFiles } from "./identity-sheets.ts";

test("authoring sheet files persist independently of a Persona and protect both styles with CAS and an in-flight lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "identity-sheets-"));
  const first = "/images/11111111-1111-4111-8111-111111111111.png";
  const second = "/images/22222222-2222-4222-8222-222222222222.png";
  try {
    const store = identitySheetFiles(directory);
    expect(await store.sheets("draft")).toEqual({});
    await expect(store.sheets("../escape")).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.saveSheet("../escape", "anime", first)).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(
      store.saveSheet("draft", "anime", "https://outside.test/image.jpg"),
    ).rejects.toMatchObject({ kind: "invalid" });
    const results = await Promise.allSettled([
      store.saveSheet("draft", "anime", first),
      store.saveSheet("draft", "photo", first),
      store.clearSheets("draft"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { kind: "conflict" } });
    await expect(store.saveSheet("draft", "anime", second)).rejects.toMatchObject({
      kind: "conflict",
    });
    await store.saveSheet("draft", "anime", second, first, "operation-anime");
    await store.saveSheet("draft", "photo", first);
    expect(await identitySheetFiles(directory).sheets("draft")).toEqual({
      anime: second,
      photo: first,
    });
    expect(await readdir(join(directory, "identity-sheets"))).toEqual(["draft.json"]);
    expect(await store.sheetResult("draft", "anime", "operation-anime")).toBe(second);
    expect(await store.sheetResult("draft", "anime", "old-operation")).toBeUndefined();
    await expect(store.clearSheets("../escape")).rejects.toMatchObject({ kind: "invalid" });
    await store.clearSheets("draft");
    expect(await store.sheets("draft")).toEqual({});
    await mkdir(join(directory, "identity-sheets", "bad.json"));
    await expect(store.sheets("bad")).rejects.toMatchObject({ code: "EISDIR" });
    await writeFile(
      join(directory, "identity-sheets", "corrupt.json"),
      '{"sheets":{"anime":42},"operations":{}}',
    );
    await expect(store.sheets("corrupt")).rejects.toThrow(/anime/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
