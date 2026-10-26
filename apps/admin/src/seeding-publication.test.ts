import { afterEach, expect, test, vi } from "vitest";
import { completedSeed, markSaveFailed } from "../test/seeding-failures.ts";
import {
  request,
  tokenOf,
  fixture,
  initialDocuments,
  portraitImage,
  portraitReply,
} from "../test/fixtures.ts";
import { deferred } from "../test/queue.ts";
import { createAdmin } from "./admin.ts";
import { seedingStore } from "./seeding-store.ts";
import { pricedSeedingModels } from "./seeding-budget.ts";
import { generator } from "../test/fixtures.ts";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { uploadSeeds } from "../test/seeding.ts";
import { editingStorage } from "./editing-storage.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function expectRetryLocked({
  admin,
  db,
  person,
  location,
}: Pick<Awaited<ReturnType<typeof completedSeed>>, "admin" | "db" | "person" | "location">) {
  await markSaveFailed(db, person.id);
  expect(
    (await admin.fetch(request(location, { intent: "retry", persona: person.id }))).status,
  ).toBe(409);
  await db
    .prepare("UPDATE seeding_seeds SET stage = 'done' WHERE personaId = ?")
    .bind(person.id)
    .run();
}

test.each(["save", "read", "stale"] as const)(
  "bulk publication %s failures identify the selected Persona in correlated diagnostics",
  async (failure) => {
    const { admin, db, person, selection, location, logs } = await completedSeed();
    if (failure === "save")
      await db
        .prepare(
          "CREATE TRIGGER reject_publication BEFORE UPDATE ON personas WHEN new.published = 1 BEGIN SELECT RAISE(FAIL, 'publication unavailable'); END",
        )
        .run();
    if (failure === "read") await db.prepare("DROP TABLE persona_images").run();
    const response = await admin.fetch(
      request(location, {
        intent: "publish",
        persona: failure === "stale" ? `${person.id}:stale` : selection,
      }),
    );
    expect(response.status).toBe(failure === "stale" ? 409 : 503);
    const diagnostics = logs.stderr.mock.calls.join(" ");
    expect(diagnostics).toContain(`"personaId":"${person.id}"`);
    expect(diagnostics).toContain(`"requestId":"${response.headers.get("x-request-id")}"`);
    expect(diagnostics).toContain(
      `"stage":"${failure === "save" ? "persistence.database" : "seeding.publish.validate"}"`,
    );
    expect(diagnostics).not.toContain(person.description);
  },
);

test("publication shares the editor lock with image submissions, row retries and competing publications", async () => {
  const { open, person, selection, location, provider, storage, db } = await completedSeed();
  const admin = await open({
    APPLICATION_API_URL: "https://management.example",
    TOKEN_MANAGEMENT: "private-management-key",
  });
  const editor = await (await admin.fetch(request(`/personas/${person.id}`))).text();
  const fields = { name: person.name, description: person.description!, draft: tokenOf(editor) };
  const notification = deferred<Response>();
  const entered = deferred<void>();
  provider.mockImplementationOnce(() => {
    entered.resolve();
    return notification.promise;
  });
  const publishing = admin.fetch(request(location, { intent: "publish", persona: selection }));
  await entered.promise;
  await expectRetryLocked({ admin, db, person, location });
  expect(
    (await admin.fetch(request(location, { intent: "publish", persona: selection }))).status,
  ).toBe(409);
  expect(
    (await admin.fetch(request(`/personas/${person.id}`, { ...fields, intent: "generate" })))
      .status,
  ).toBe(409);
  const jobId = [...(await storage.list<{ id: string }>({ prefix: "job:" })).values()][0]!.id;
  expect((await admin.fetch(request(`/image-jobs/${jobId}/clear`, fields))).status).toBe(409);
  notification.resolve(new Response(null, { status: 204 }));
  expect((await publishing).status).toBe(303);
  expect(await (await admin.fetch(request(location))).text()).toContain("Published");
});

test("publication rejects unsaved edits, unknown selections and storage failures without publishing", async () => {
  const { admin, person, selection, location, db, store, provider } = await completedSeed();
  expect(
    (await admin.fetch(request(location, { intent: "publish", persona: "not-in-run:hash" })))
      .status,
  ).toBe(400);
  const editor = await (await admin.fetch(request(`/personas/${person.id}`))).text();
  // A persisted unsaved draft is retained by the image action, as in the ordinary editor.
  const pending = await admin.fetch(
    request(`/personas/${person.id}`, {
      name: person.name,
      description: person.description!,
      intent: "generate",
      draft: tokenOf(editor),
    }),
  );
  expect(pending.status).toBe(303);
  await expectRetryLocked({ admin, db, person, location });
  expect(
    (await admin.fetch(request(location, { intent: "publish", persona: selection }))).status,
  ).toBe(409);
  provider.mockResolvedValueOnce(await portraitReply());
  await admin.alarm();
  expect(
    (await admin.fetch(request(location, { intent: "publish", persona: selection }))).status,
  ).toBe(409);
  expect((await store.get(person.id)).published).toBe(false);
  await db.prepare("DROP TABLE persona_images").run();
  expect((await admin.fetch(request(location))).status).toBe(503);
});

test("bulk review refuses missing or invalid initial documents at the real file-storage boundary", async () => {
  const { root, store } = await fixture();
  const { db } = await cloudflareFixture();
  const editing = editingStorage(memoryStorage().storage);
  const admin = createAdmin(store, "test-password", {
    generator,
    seeding: { repository: seedingStore(db), models: pricedSeedingModels },
    persistence: { checkpoint: editing.save, wake: async () => {} },
  });
  const location = (await admin(uploadSeeds())).headers.get("location")!;
  await admin(request(location, { intent: "confirm", budget: "12" }));
  const row = (await db
    .prepare("SELECT personaId FROM seeding_seeds ORDER BY ordinal LIMIT 1")
    .first<{ personaId: string }>())!;
  const image = await store.saveImage(portraitImage);
  await store.save(
    {
      ...databasePersona,
      id: row.personaId,
      imageUrl: image,
      portraits: { anime: image, photo: image },
    },
    initialDocuments,
    { persona: "" },
  );
  await db
    .prepare("UPDATE seeding_seeds SET stage = 'done', pending = 0 WHERE personaId = ?")
    .bind(row.personaId)
    .run();
  await rm(join(root, "initial", row.personaId), { recursive: true });
  const selection = /name="persona" value="([^"]+)"/.exec(
    await (await admin(request(location))).text(),
  )![1]!;
  expect((await admin(request(location, { intent: "publish", persona: selection }))).status).toBe(
    400,
  );
  expect((await store.get(row.personaId)).published).toBe(false);
  // Recover the initial pair, then verify publication validates its contents too.
  await store.save(await store.get(row.personaId), initialDocuments, {
    persona: await store.source(row.personaId),
  });
  await writeFile(join(root, "initial", row.personaId, "STATE.md"), "invalid state");
  const latest = /name="persona" value="([^"]+)"/.exec(
    await (await admin(request(location))).text(),
  )![1]!;
  expect((await admin(request(location, { intent: "publish", persona: latest }))).status).toBe(400);
});
