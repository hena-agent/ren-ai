import { expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { serializePersona } from "@ren-ai/personas";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { fixture, initialDocuments, portraitImage, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { personaQuery, personaPageUrl } from "./persona-query.ts";
import type { LogEntry } from "./logging.ts";

const query = (search = "") => personaQuery(new URLSearchParams(search));

test("D1 listing paginates by creation time with deterministic ties, bounded photos and retained URL conditions", async () => {
  const { store, db } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  for (let i = 0; i < 23; i++) {
    const id = `persona-${String(i).padStart(2, "0")}`;
    await store.save(
      { ...databasePersona, id, name: "검색 대상", imageUrl, portraits: { photo: imageUrl } },
      initialDocuments,
      { persona: "" },
    );
    await db
      .prepare("UPDATE personas SET createdAt = ?, updatedAt = ? WHERE id = ?")
      .bind(Math.floor(i / 2), 100 - i, id)
      .run();
  }
  const options = query("q=검색&published=private&style=photo&language=fr");
  const first = await store.browse(options);
  expect(first).toMatchObject({ total: 23, page: 1, pages: 2, languages: ["fr"] });
  expect(first.personas).toHaveLength(20);
  expect(first.personas[0]!.id).toBe("persona-22");
  expect(first.personas[1]!.id).toBe("persona-21");
  expect(first.personas.every((persona) => persona.portraits?.photo === imageUrl)).toBe(true);
  const second = await store.browse({ ...options, page: 2 });
  expect(second.personas.map(({ id }) => id)).toEqual(["persona-02", "persona-01", "persona-00"]);
  expect(new Set([...first.personas, ...second.personas].map(({ id }) => id)).size).toBe(23);
  expect(await store.browse({ ...options, page: Number.MAX_SAFE_INTEGER })).toEqual(second);
  expect((await store.browse(query("sort=oldest"))).personas[0]!.id).toBe("persona-01");
  expect((await store.browse(query("sort=updated"))).personas[0]!.id).toBe("persona-00");
  const saved = await store.get("persona-00");
  await store.save({ ...saved, timeZone: "Asia/Seoul" }, initialDocuments, {
    persona: serializePersona(saved),
    initial: initialDocuments,
  });
  expect((await store.browse(query())).personas[0]!.id).toBe("persona-22");
  expect((await store.browse(query("sort=updated"))).personas[0]!.id).toBe("persona-00");

  const admin = createAdmin(store, "test-password", "", { log: () => {} });
  const browser = new Window();
  try {
    browser.document.write(await (await admin(request(personaPageUrl(options, 1)))).text());
    const form = browser.document.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.querySelector('[name="page"]')).toBeNull();
    expect(browser.document.querySelectorAll(".card-link")).toHaveLength(20);
    const next = browser.document.querySelector('a[rel="next"]')!.getAttribute("href")!;
    expect(query(next.split("?")[1])).toEqual({ ...options, page: 2 });
    browser.document.body.innerHTML = await (await admin(request(next))).text();
    expect(browser.document.querySelectorAll(".card-link")).toHaveLength(3);
    expect(browser.document.querySelector('a[rel="prev"]')).not.toBeNull();
    expect(browser.document.querySelector('a[rel="next"]')).toBeNull();
  } finally {
    await browser.happyDOM.close();
  }
  const plan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM personas ORDER BY createdAt DESC, id DESC LIMIT 20 OFFSET 20",
    )
    .all();
  expect(JSON.stringify(plan.results)).toContain("persona_created_order");
  expect(JSON.stringify(plan.results)).not.toContain("TEMP B-TREE");
  const updatedPlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM personas ORDER BY updatedAt DESC, id DESC LIMIT 20 OFFSET 20",
    )
    .all();
  expect(JSON.stringify(updatedPlan.results)).toContain("persona_updated_order");
  expect(JSON.stringify(updatedPlan.results)).not.toContain("TEMP B-TREE");
});

test("D1 filters combine, use literal name/ID search and only count gallery photos", async () => {
  const { store } = await cloudflareFixture();
  const imageUrl = await store.saveImage(portraitImage);
  for (const record of [
    {
      ...databasePersona,
      id: "alpha",
      name: "Alpha 100%_\\",
      description: databasePersona.prompt.replaceAll(databasePersona.name, "Alpha 100%_\\"),
      published: true,
      imageUrl,
      portraits: { photo: imageUrl },
    },
    {
      ...databasePersona,
      id: "beta",
      name: "애니",
      language: "ko",
      imageUrl,
      portraits: { anime: imageUrl },
    },
    { ...databasePersona, id: "empty", name: "빈 프로필" },
  ])
    await store.save(record, initialDocuments, { persona: "" });
  await store.saveSheet("empty", "photo", imageUrl);
  const ids = async (search: string) =>
    (await store.browse(query(search))).personas.map(({ id }) => id);
  expect(await ids("q=ALPHA&published=published&style=photo&language=fr")).toEqual(["alpha"]);
  expect(await ids("q=100%25_\\")).toEqual(["alpha"]);
  expect(await ids("q=beta&style=anime&published=private&language=ko")).toEqual(["beta"]);
  expect(await ids("style=none")).toEqual(["empty"]);
  expect(await ids("q=빈 프로필")).toEqual(["empty"]);
  expect(await ids("q=비공개 설정")).toEqual([]);
  expect(await ids("q=' OR 1=1 --")).toEqual([]);
  expect(await ids("style=photo&published=private")).toEqual([]);
  const none = await store.browse(query("language=missing&page=4"));
  expect(none).toMatchObject({
    total: 0,
    pages: 1,
    page: 1,
    personas: [],
    languages: ["fr", "ko"],
  });
});

test("listing failures retain request diagnostics and invalid query parameters are rejected", async () => {
  const { store, db } = await cloudflareFixture();
  const logs: LogEntry[] = [];
  const admin = createAdmin(store, "test-password", "", { log: (entry) => logs.push(entry) });
  for (const search of [
    "page=0",
    "page=1&page=2",
    "sort=newest&sort=invalid",
    "page=-1",
    "page=1.5",
    "page=NaN",
    "page=9007199254740992",
    "q=" + "a".repeat(101),
    "language=" + "a".repeat(51),
    "published=bad",
    "style=bad",
    "sort=bad",
  ]) {
    expect((await admin(request(`/?${search}`))).status).toBe(400);
  }
  expect(query("q=%20하린%20").q).toBe("하린");
  await db.prepare("DROP TABLE persona_images").run();
  const response = await admin(request("/?style=photo"));
  expect(response.status).toBe(503);
  const error = logs.find((entry) => entry.level === "error")!;
  expect(error).toMatchObject({ stage: "persistence.database", code: "database_error" });
  expect(await response.text()).toContain(error.requestId);
});

test("filesystem-backed Admin applies the same filters, sorting and pagination", async () => {
  const { store, admin } = await fixture();
  const now = vi.spyOn(Date, "now");
  try {
    for (let i = 0; i < 22; i++) {
      now.mockReturnValue(1000 + Math.floor(i / 2));
      await store.create({
        ...databasePersona,
        id: `file-${String(i).padStart(2, "0")}`,
        name: "파일",
        imageUrl: "",
        language: i === 0 ? "ko" : "fr",
      });
    }
  } finally {
    now.mockRestore();
  }
  expect((await store.browse(query())).personas[0]!.id).toBe("file-21");
  expect((await store.browse(query("sort=oldest"))).personas[0]!.id).toBe("file-01");
  expect((await store.browse(query("page=2"))).personas.map(({ id }) => id)).toEqual([
    "file-01",
    "file-00",
  ]);
  await store.update({
    ...(await store.get("file-00")),
    name: "Updated",
    published: true,
    imageUrl: "https://example.com/photo.png",
    portraits: { photo: "https://example.com/photo.png" },
  });
  expect((await store.browse(query("sort=updated"))).personas[0]!.id).toBe("file-00");
  for (const search of ["q=UPDATED&published=published&style=photo&language=ko", "q=file-00"]) {
    expect((await store.browse(query(search))).personas.map(({ id }) => id)).toEqual(["file-00"]);
  }
  expect((await store.browse(query("published=private&style=none"))).total).toBe(21);
  expect((await store.browse(query("style=anime"))).total).toBe(0);
  expect((await store.browse(query("language=fr"))).total).toBe(21);
  for (const search of [
    "q=missing",
    "published=published&language=fr",
    "style=anime",
    "language=missing",
  ]) {
    const page = await (await admin(request(`/?${search}`))).text();
    expect(page).toContain("검색 결과가 없습니다.");
    expect(page).toContain("조건 초기화");
  }
});
