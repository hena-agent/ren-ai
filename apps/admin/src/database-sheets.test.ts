import { expect, test } from "vitest";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { databaseSheets } from "./database-sheets.ts";
import { initialDocuments, portraitImage } from "../test/fixtures.ts";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { identitySheets } from "./database-schema.ts";

test("D1 sheets are independent of Persona publication and survive store replacement, with per-style CAS", async () => {
  const { store, db } = await cloudflareFixture();
  expect(
    getTableConfig(identitySheets).primaryKeys[0]!.columns.map((column) => column.name),
  ).toEqual(["personaId", "style"]);
  expect(await store.sheets("draft")).toEqual({});
  const first = await store.saveImage(portraitImage);
  const second = await store.saveImage(portraitImage);
  await store.saveSheet("draft", "anime", first);
  const next = databaseSheets(db, "https://persona-images.renai.im/");
  expect(await next.sheets("draft")).toEqual({ anime: first });
  await expect(next.saveSheet("draft", "anime", second)).rejects.toMatchObject({
    kind: "conflict",
  });
  await next.saveSheet("draft", "anime", second, first, "operation-anime");
  expect(await next.sheetResult("draft", "anime", "operation-anime")).toBe(second);
  expect(await next.sheetResult("draft", "anime", "old-operation")).toBeUndefined();
  await expect(next.saveSheet("draft", "anime", first, first)).rejects.toMatchObject({
    kind: "conflict",
  });
  await expect(
    next.saveSheet("draft", "photo", "https://outside.test/image.jpg"),
  ).rejects.toMatchObject({ kind: "invalid" });
  await store.saveSheet("draft", "photo", first);
  const raced = await Promise.allSettled([
    next.saveSheet("race", "photo", first),
    next.saveSheet("race", "photo", second),
  ]);
  expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(await next.sheets("draft")).toEqual({ anime: second, photo: first });
  await store.save({ ...databasePersona, id: "draft" }, initialDocuments, { persona: "" });
  expect(JSON.stringify(await store.catalog())).not.toContain(second);
  expect(await store.publicList()).toEqual([]);
  expect(await store.sheets("draft")).toEqual({ anime: second, photo: first });
  const plan = await db
    .prepare("EXPLAIN QUERY PLAN SELECT * FROM persona_identity_sheets WHERE personaId = ?")
    .bind("draft")
    .all();
  expect(JSON.stringify(plan.results)).toContain("SEARCH");
  await next.clearSheets("draft");
  expect(await next.sheets("draft")).toEqual({});
});
