import { afterEach, expect, test, vi } from "vitest";
import {
  completedSeed,
  seedingFixture,
  scriptCompleteSeed,
  markSaveFailed,
} from "../test/seeding-failures.ts";
import { seedCharacter, seedManifest } from "../test/seeding.ts";
import { acceptedReview } from "../test/character.ts";
import { request, tokenOf } from "../test/fixtures.ts";
import { serializePersona } from "@ren-ai/personas";
import { deferred } from "../test/queue.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([false, true])(
  "interrupted drafting preserves completed drafts and requires confirmation for uncertain results (completed: %s)",
  async (completed) => {
    const { admin, provider, db, open, location } = await seedingFixture();
    await db
      .prepare(
        "CREATE TRIGGER interrupt_draft BEFORE UPDATE ON seeding_seeds WHEN old.stage = 'drafting' AND new.stage != 'drafting' BEGIN SELECT RAISE(FAIL, 'simulated interruption'); END",
      )
      .run();
    if (completed)
      provider
        .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
        .mockResolvedValueOnce(acceptedReview());
    await expect(admin.alarm()).rejects.toThrow("Failed query");
    const paid = provider.mock.calls.length;
    await db.prepare("DROP TRIGGER interrupt_draft").run();
    const restarted = await open();
    await restarted.alarm();
    expect(provider).toHaveBeenCalledTimes(paid);
    const page = await (await restarted.fetch(request(location))).text();
    expect(page).toContain(completed ? "sheets" : "failed at drafting");
    if (completed) return;
    const id = /name="persona" value="([a-f0-9-]{36})"/.exec(page)![1]!;
    expect(
      (await restarted.fetch(request(location, { intent: "retry", persona: id }))).status,
    ).toBe(303);
    provider
      .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
      .mockResolvedValueOnce(acceptedReview());
    await restarted.alarm();
    expect(provider).toHaveBeenCalledTimes(paid + 2);
  },
);

test.each(["none", "persona", "initial"] as const)(
  "a committed unpublished save is recovered without paying again or overwriting newer edits (edited: %s)",
  async (edited) => {
    const { admin, provider, db, open, location, store } = await seedingFixture();
    await scriptCompleteSeed(provider);
    await db
      .prepare(
        "CREATE TRIGGER interrupt_save BEFORE UPDATE ON seeding_seeds WHEN old.stage = 'save' BEGIN SELECT RAISE(FAIL, 'simulated interruption'); END",
      )
      .run();
    for (let i = 0; i < 11; i++) await admin.alarm();
    await expect(admin.alarm()).rejects.toThrow("Failed query");
    const person = (await store.list())[0]!;
    expect(person.published).toBe(false);
    if (edited !== "none") {
      const initial = (await store.initial(person.id))!;
      await store.save(
        edited === "persona" ? { ...person, openingLine: "operator edit" } : person,
        edited === "initial"
          ? { ...initial, memory: initial.memory + "\n\n운영자가 확인한 새 기억." }
          : initial,
        {
          persona: serializePersona(person),
          initial,
        },
      );
    }
    await db.prepare("DROP TRIGGER interrupt_save").run();
    const restarted = await open();
    await restarted.alarm();
    expect(provider).toHaveBeenCalledTimes(6);
    const page = await (await restarted.fetch(request(location))).text();
    expect(page).toContain(edited !== "none" ? "failed at save" : "done");
    expect((await store.get(person.id)).openingLine).toBe(
      edited === "persona" ? "operator edit" : person.openingLine,
    );
    expect((await store.initial(person.id))!.memory.includes("운영자가 확인한 새 기억.")).toBe(
      edited === "initial",
    );
    if (edited === "none") return;
    // Opening the existing saved Persona adopts its current documents for explicit recovery.
    expect((await restarted.fetch(request(`/personas/${person.id}`))).status).toBe(200);
    expect(
      (await restarted.fetch(request(location, { intent: "retry", persona: person.id }))).status,
    ).toBe(303);
    await restarted.alarm();
    expect(await (await restarted.fetch(request(location))).text()).toContain("done");
    expect(provider).toHaveBeenCalledTimes(6);
  },
);

test("terminal seed status follows saved photos and unchanged status stays write-free", async () => {
  const { store, person, db } = await completedSeed();
  const initial = (await store.initial(person.id))!;
  await db.prepare("CREATE TABLE seed_status_writes (stage TEXT)").run();
  await db
    .prepare(
      "CREATE TRIGGER record_seed_status AFTER UPDATE ON seeding_seeds BEGIN INSERT INTO seed_status_writes VALUES (new.stage); END",
    )
    .run();
  const save = async (record: typeof person) =>
    store.save(record, initial, {
      persona: serializePersona(await store.get(person.id)),
      initial,
    });
  await save(person);
  expect((await db.prepare("SELECT stage FROM seed_status_writes").all()).results).toEqual([]);
  await save({ ...person, portraits: { anime: person.portraits!.anime! } });
  expect(
    await db.prepare("SELECT stage FROM seeding_seeds WHERE personaId = ?").bind(person.id).first(),
  ).toEqual({ stage: "partial" });
  await save(person);
  expect((await db.prepare("SELECT stage FROM seed_status_writes").all()).results).toEqual([
    { stage: "partial" },
    { stage: "done" },
  ]);
});

test("confirmed save recovery locks version restores until seeding completes", async () => {
  const { admin, person, store, db, location } = await completedSeed();
  const path = `/personas/${person.id}/versions`;
  const versions = await (await admin.fetch(request(path))).text();
  await markSaveFailed(db, person.id);
  expect(
    (await admin.fetch(request(location, { intent: "retry", persona: person.id }))).status,
  ).toBe(303);
  expect(
    (await admin.fetch(request(`${path}/1/restore`, { draft: tokenOf(versions) }))).status,
  ).toBe(409);
  expect(await store.get(person.id)).toEqual(person);
  await admin.alarm();
  expect((await admin.fetch(request(path))).status).toBe(200);
});

test("concurrent alarms cannot duplicate a paid draft and source edits remain locked during the seeding run", async () => {
  const { admin, provider, location } = await seedingFixture();
  const response = deferred<Response>();
  const started = deferred<void>();
  provider
    .mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    })
    .mockResolvedValueOnce(acceptedReview());
  const working = admin.alarm();
  await started.promise;
  await admin.alarm();
  response.resolve(seedCharacter(seedManifest().seeds[0]!));
  await working;
  expect(provider).toHaveBeenCalledTimes(2);
  await admin.alarm();
  const page = await (await admin.fetch(request(location))).text();
  expect(page).toContain("sheets");
  // The ordinary queue page is the operator's live draft boundary.
  const jobPath = /href="(\/image-jobs\/[^"]+)"/.exec(page)![1]!;
  const jobPage = await (await admin.fetch(request(jobPath))).text();
  expect(
    (await admin.fetch(request("/personas", { intent: "save", draft: tokenOf(jobPage) }))).status,
  ).toBe(409);
});

test("aged-out waiting seeds stop before paying", async () => {
  const { admin, provider, location } = await seedingFixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2046-10-20T00:00:00Z"));
  await admin.alarm();
  expect(provider).not.toHaveBeenCalled();
  expect(await (await admin.fetch(request(location))).text()).toContain("failed at draft");
});

test("age eligibility is rechecked when waiting images actually dispatch", async () => {
  const { admin, provider } = await seedingFixture();
  await scriptCompleteSeed(provider);
  await admin.alarm();
  await admin.alarm();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2046-10-20T00:00:00Z"));
  await admin.alarm();
  expect(provider).toHaveBeenCalledTimes(2);
});

test("a confirmed retry reuses a retained text draft after a stage-write failure", async () => {
  const { admin, provider, db, open, location } = await seedingFixture();
  provider
    .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
    .mockResolvedValueOnce(acceptedReview());
  await db
    .prepare(
      "CREATE TRIGGER reject_sheets BEFORE UPDATE ON seeding_seeds WHEN new.stage = 'sheets' BEGIN SELECT RAISE(FAIL, 'stage unavailable'); END",
    )
    .run();
  await admin.alarm();
  await db.prepare("DROP TRIGGER reject_sheets").run();
  const restarted = await open();
  const page = await (await restarted.fetch(request(location))).text();
  expect(page).toContain("failed at drafting");
  const id = /name="persona" value="([a-f0-9-]{36})"/.exec(page)![1]!;
  expect((await restarted.fetch(request(location, { intent: "retry", persona: id }))).status).toBe(
    303,
  );
  await restarted.alarm();
  expect(provider).toHaveBeenCalledTimes(2);
  expect(await (await restarted.fetch(request("/seeding"))).text()).toContain("Confirmed");
});

test("save-read failures stop safely and an explicit save retry does not regenerate", async () => {
  const { person, admin, db, location, provider, logs } = await completedSeed();
  await db
    .prepare("UPDATE seeding_seeds SET stage = 'save', pending = 1 WHERE personaId = ?")
    .bind(person.id)
    .run();
  await db.prepare("ALTER TABLE persona_images RENAME TO interrupted_images").run();
  await admin.alarm();
  expect(logs.stderr.mock.calls.join(" ")).toContain("seeding.advance");
  await db.prepare("ALTER TABLE interrupted_images RENAME TO persona_images").run();
  const page = await (await admin.fetch(request(location))).text();
  expect(page).toContain("failed at save");
  expect(
    (await admin.fetch(request(location, { intent: "retry", persona: person.id }))).status,
  ).toBe(303);
  await admin.alarm();
  expect(provider).toHaveBeenCalledTimes(6);
  expect(await (await admin.fetch(request(location))).text()).toContain("done");
});
