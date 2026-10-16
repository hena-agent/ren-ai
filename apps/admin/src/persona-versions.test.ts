import { expect, test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PersonaError, serializePersona } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import {
  initialDocuments,
  portraitImage,
  request,
  tokenOf,
  fixture,
  character,
  legacy,
  generator,
} from "../test/fixtures.ts";
import { GenerationError } from "./logging.ts";
import { deferred, queuedRequest, finishedJob, jobUrl } from "../test/queue.ts";
import { createAdmin } from "./admin.ts";
import type { LogEntry } from "./logging.ts";

const secondDocument = withPublicProfile(
  databasePersona.description!,
  "두 번째 소개.\n\n### 관심사\n\n- 산책",
);
async function versionFixture() {
  const result = await cloudflareFixture();
  const imageUrl = await result.store.saveImage(portraitImage);
  const first = await result.store.save(
    { ...databasePersona, imageUrl, portraits: { photo: imageUrl }, published: true },
    initialDocuments,
    { persona: "" },
  );
  const logs: LogEntry[] = [];
  const admin = createAdmin(result.store, "test-password", "", {
    log: (entry) => logs.push(entry),
  });
  return { ...result, first, admin, logs, path: `/personas/${first.id}` };
}
const expected = (persona: typeof databasePersona, initial = initialDocuments) => ({
  persona: serializePersona(persona),
  initial,
});

test("the storage upgrade preserves existing Persona documents as v1 without changing initials, metadata or photo links", async () => {
  const { db, store } = await cloudflareFixture(undefined, undefined, async (binding) => {
    await binding
      .prepare(
        "INSERT INTO personas (id, name, gender, descriptionVersion, markdown, timeZone, language, openingLine, memoryInstruction, published, state, memory, revision, commitId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        databasePersona.id,
        databasePersona.name,
        databasePersona.gender!,
        2,
        databasePersona.description!,
        databasePersona.timeZone,
        databasePersona.language,
        databasePersona.openingLine,
        databasePersona.memory,
        0,
        initialDocuments.state,
        initialDocuments.memory,
        7,
        "old-commit",
        100,
        200,
      )
      .run();
    await binding
      .prepare(
        "INSERT INTO persona_images VALUES (?, '00000000-0000-0000-0000-000000000001.jpg', 'photo', 0, 'image/jpeg', 16)",
      )
      .bind(databasePersona.id)
      .run();
  });
  const current = await store.get(databasePersona.id);
  expect(current).toMatchObject({
    version: 1,
    description: databasePersona.description,
    portraits: { photo: "/discovery/images/00000000-0000-0000-0000-000000000001.jpg" },
  });
  expect(await store.version(current.id, 1)).toMatchObject({
    markdown: databasePersona.description,
    createdAt: 200,
  });
  expect(await store.initial(current.id)).toEqual(initialDocuments);
  expect(await db.prepare("SELECT revision, createdAt, updatedAt FROM personas").first()).toEqual({
    revision: 7,
    createdAt: 100,
    updatedAt: 200,
  });
  expect(
    (await db.prepare("PRAGMA table_info(personas)").all<{ name: string }>()).results.map(
      (column) => column.name,
    ),
  ).not.toContain("markdown");
});

test("only document edits append immutable versions; private/public Catalogs expose current content and restoration preserves photos and initials", async () => {
  const { store, first, admin, path, logs } = await versionFixture();
  const newImage = await store.saveImage(portraitImage);
  const initial = { ...initialDocuments, memory: "# 현재 생활\n\n새로운 생활 기록." };
  const metadata = await store.save(
    { ...first, portraits: { photo: newImage }, imageUrl: newImage },
    initial,
    expected(first),
  );
  expect(metadata.version).toBe(1);
  expect(await store.versions(first.id)).toHaveLength(1);
  const revised = secondDocument.replace("이름: 하린", "이름: 하린 수정");
  const second = await store.save(
    { ...metadata, name: "하린 수정", description: revised },
    initial,
    expected(metadata, initial),
  );
  expect(second.version).toBe(2);
  expect((await store.version(first.id, 1)).markdown).toBe(first.description);
  expect((await store.catalog()).personas[0]!.source).toContain("version: 2");
  expect((await store.publicList())[0]!.bio).toBe("두 번째 소개.");
  const view = await (await admin(request(`${path}/versions?version=1`))).text();
  expect(view).toContain("버전 기록");
  expect(view).toContain("현재 v2");
  const restored = await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(view) }));
  expect(restored.status).toBe(303);
  const current = await store.get(first.id);
  expect(current.version).toBe(3);
  expect(current.description).toBe(first.description);
  expect(current.name).toBe(first.name);
  expect(current.portraits).toEqual(metadata.portraits);
  expect(current.published).toBe(true);
  expect(await store.initial(first.id)).toEqual(initial);
  expect(await store.versions(first.id)).toMatchObject([
    { version: 3, restoredFrom: 1 },
    { version: 2, restoredFrom: null },
    { version: 1, restoredFrom: null },
  ]);
  expect((await store.version(first.id, 2)).markdown).toBe(revised);
  expect(JSON.stringify(await store.publicList())).not.toMatch(/version|restoredFrom|비공개/);
  expect(JSON.stringify(logs)).not.toContain(first.description);
  expect(
    logs.find(
      (entry) => entry.stage === "persona.restore" && entry.event === "operation.completed",
    ),
  ).toMatchObject({
    personaVersion: 3,
    restoredFrom: 1,
    requestId: restored.headers.get("x-request-id"),
  });
});

test("rollback creates a new version even for identical text and stale editor tokens cannot overwrite ABA changes", async () => {
  const { store, first, admin, path } = await versionFixture();
  const oldPage = await (await admin(request(path))).text();
  const second = await store.save(
    { ...first, description: secondDocument },
    initialDocuments,
    expected(first),
  );
  await store.save(first, initialDocuments, { ...expected(second), restoredFrom: 1 });
  const response = await admin(
    request(path, {
      name: first.name,
      description: first.description,
      published: "on",
      draft: tokenOf(oldPage),
    }),
  );
  expect(response.status).toBe(409);
  const before = await store.get(first.id);
  const history = await (await admin(request(`${path}/versions?version=1`))).text();
  expect(
    (await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(history) }))).status,
  ).toBe(303);
  expect((await store.get(first.id)).version).toBe(4);
  expect((await store.get(first.id)).description).toBe(before.description);
  expect(
    (await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(history) }))).status,
  ).toBe(409);
});

test("the current applied version cannot be restored as a duplicate", async () => {
  const { admin, path, first } = await versionFixture();
  const page = await (await admin(request(`${path}/versions?version=1`))).text();
  const response = await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(page) }));
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("현재 버전은 이미 적용");
  expect((await admin(request(path))).status).toBe(200);
  expect(first.version).toBe(1);
});

test("a failed history insert rolls back current metadata, initials and photos and logs safe persistence diagnostics", async () => {
  const { db, store, first, admin, path, logs } = await versionFixture();
  const page = await (await admin(request(path))).text();
  await db.exec(
    "CREATE TRIGGER reject_version BEFORE INSERT ON persona_versions WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
  );
  const response = await admin(
    request(path, {
      name: first.name,
      description: secondDocument,
      published: "on",
      draft: tokenOf(page),
    }),
  );
  expect(response.status).toBe(503);
  expect(await store.get(first.id)).toEqual(first);
  expect(await store.initial(first.id)).toEqual(initialDocuments);
  expect(await store.versions(first.id)).toHaveLength(1);
  expect(logs.filter((entry) => entry.event === "operation.failed")).toHaveLength(1);
  expect(logs.find((entry) => entry.event === "operation.failed")).toMatchObject({
    requestId: response.headers.get("x-request-id"),
    code: "database_error",
    stage: "persistence.database",
  });
  expect(JSON.stringify(logs)).not.toContain(secondDocument);
});

test("version history rejects unsaved input without losing it, guards authentication and validates selections", async () => {
  const { admin, path, first, store } = await versionFixture();
  const page = await (await admin(request(path))).text();
  const edit = `${first.description}\n\n저장하지 않은 편집`;
  expect(
    (
      await admin(
        request(`${path}/versions`, {
          name: first.name,
          description: first.description.replace(/\n/g, "\r\n"),
          published: "on",
          draft: tokenOf(page),
        }),
      )
    ).status,
  ).toBe(200);
  for (const initialEdit of [
    { stateSource: initialDocuments.state.replace("mood: 55", "mood: 77") },
    { memorySource: "현재 편집 중인 생활 기억" },
  ]) {
    const changed = await admin(
      request(`${path}/versions`, {
        name: first.name,
        description: first.description,
        published: "on",
        draft: tokenOf(page),
        ...initialEdit,
      }),
    );
    expect(changed.status).toBe(409);
  }
  const response = await admin(
    request(`${path}/versions`, {
      name: first.name,
      description: edit,
      published: "on",
      stateSource: initialDocuments.state,
      memorySource: "수정한 메모리",
      draft: tokenOf(page),
    }),
  );
  expect(response.status).toBe(409);
  const failure = await response.text();
  expect(failure).toContain("저장하지 않은 편집");
  expect(failure).toContain("수정한 메모리");
  expect((await admin(new Request(`http://localhost:3729${path}/versions`))).status).toBe(401);
  expect((await admin(request(`${path}/versions-extra`))).status).toBe(404);
  for (const version of ["0", "no", "1.5", "9999999999999999999999"])
    expect((await admin(request(`${path}/versions?version=${version}`))).status).toBe(400);
  expect((await admin(request(`${path}/versions?version=7`))).status).toBe(404);
  expect((await admin(request(`${path}/versions/1/restore`))).status).toBe(400);
  expect(
    (await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(page) }))).status,
  ).toBe(400);
  const foreign = request(`${path}/versions/1/restore`, { draft: tokenOf(page) });
  foreign.headers.set("origin", "https://elsewhere.example");
  expect((await admin(foreign)).status).toBe(400);
  expect(await store.get(first.id)).toEqual(first);
  expect((await store.version(first.id, 1)).markdown).toBe(first.description);
  await expect(store.versions("missing")).rejects.toMatchObject({ kind: "not_found" });
});

test("concurrent saves cannot publish history or photo links belonging to a losing CAS", async () => {
  const { store, first } = await versionFixture();
  const results = await Promise.allSettled([
    store.save({ ...first, description: secondDocument }, initialDocuments, expected(first)),
    store.save(
      { ...first, description: `${secondDocument}\n\n다른 수정` },
      initialDocuments,
      expected(first),
    ),
  ]);
  expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((entry) => entry.status === "rejected")).toHaveLength(1);
  expect((await store.get(first.id)).version).toBe(2);
  expect(await store.versions(first.id)).toHaveLength(2);
  expect((await store.version(first.id, 2)).markdown).toBe((await store.get(first.id)).description);
});

test("published rollback reports incompatible current initials without replacing them or creating a version", async () => {
  const { store, first, admin, path } = await versionFixture();
  const initial = {
    ...initialDocuments,
    state: initialDocuments.state.replace("도움 요청 회피", "다른 특성"),
  };
  const second = await store.save(
    { ...first, description: first.description.replace("도움 요청 회피", "다른 특성") },
    initial,
    expected(first),
  );
  const page = await (await admin(request(`${path}/versions?version=1`))).text();
  const response = await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(page) }));
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("State");
  expect(await store.get(first.id)).toEqual(second);
  expect(await store.initial(first.id)).toEqual(initial);
  expect(await store.versions(first.id)).toHaveLength(2);
});

test("history opens from a saved editor and filesystem restore can preserve an uninitialized private Persona", async () => {
  const { store, admin } = await fixture();
  await store.create({ ...legacy, ...character });
  const path = "/personas/legacy";
  const editor = await (await admin(request(path))).text();
  const opened = await admin(request(`${path}/versions`, { ...character, draft: tokenOf(editor) }));
  expect(opened.status).toBe(200);
  expect(await opened.text()).toContain("선택한 v");
  const first = await store.get("legacy");
  await store.update({ ...first, description: `${first.description}\n\n수정한 소개.` });
  expect((await admin(request(`${path}/versions/1/restore`))).status).toBe(400);
  const history = await (await admin(request(`${path}/versions`))).text();
  const result = await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(history) }));
  expect(result.status).toBe(303);
  expect((await store.get("legacy")).description).toBe(first.description);
  expect((await store.get("legacy")).version).toBe(3);
  expect((await admin(request("/personas/missing/versions"))).status).toBe(404);
  const other = await store.create({ ...legacy, ...character, id: "other" });
  const otherPage = await (await admin(request(`/personas/${other.id}`))).text();
  expect(
    (await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(otherPage) }))).status,
  ).toBe(400);
});

test("restoring the current version is rejected and pre-versioned local records start with a virtual v1", async () => {
  const { admin, store, root } = await fixture();
  const description = character.description.replace("이름: 하린", "이름: 미라");
  const path = "/personas/legacy";
  const markdown = serializePersona({
    ...legacy,
    ...character,
    name: "미라",
    description,
    prompt: description,
  }).replace("version: 1\n", "");
  await writeFile(join(root, "legacy.md"), markdown);
  expect((await store.get("legacy")).version).toBeUndefined();
  const page = await (await admin(request(`${path}/versions?version=1`))).text();
  expect(page).toContain("현재 v1");
  expect(
    (await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(page) }))).status,
  ).toBe(400);
  expect((await store.get("legacy")).version).toBeUndefined();
});

test("restoring an older database version creates a new latest version", async () => {
  const { store, first, admin, path } = await versionFixture();
  await store.save({ ...first, description: secondDocument }, initialDocuments, expected(first));
  const current = await (await admin(request(`${path}/versions`))).text();
  const restored = await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(current) }));
  expect(restored.status).toBe(303);
  expect(await store.get(first.id)).toMatchObject({ description: first.description, version: 3 });
  expect(await store.versions(first.id)).toHaveLength(3);
});

test("rollback failure preserves current content and reports safe causes for invalid history and I/O errors", async () => {
  const { store, admin, first, logs, path } = await versionFixture();
  const history = await (await admin(request(`${path}/versions`))).text();
  const read = vi
    .spyOn(store, "version")
    .mockRejectedValueOnce(Object.assign(new Error(`echo ${first.description}`), { code: "EIO" }));
  const failedRead = await admin(request(`${path}/versions?version=1`));
  expect(failedRead.status).toBe(503);
  expect(logs.find((entry) => entry.code === "version_storage_failed")).toMatchObject({
    requestId: failedRead.headers.get("x-request-id"),
    causeCode: "EIO",
    stage: "persona.version.read",
  });
  expect(JSON.stringify(logs)).not.toContain(first.description);
  read.mockRestore();
  vi.spyOn(store, "versions").mockRejectedValueOnce(
    new GenerationError("Database unavailable", { code: "database_error" }),
  );
  expect((await admin(request(`${path}/versions`))).status).toBe(503);
  vi.spyOn(store, "versions").mockRejectedValueOnce(
    new PersonaError("not_found", "Persona disappeared"),
  );
  expect((await admin(request(`${path}/versions`))).status).toBe(404);
  const second = await store.save(
    { ...first, description: secondDocument },
    initialDocuments,
    expected(first),
  );
  const currentPage = await (await admin(request(`${path}/versions`))).text();
  const bad = vi.spyOn(store, "version").mockResolvedValueOnce({
    version: 1,
    markdown: "private corrupt history",
    createdAt: 1,
    restoredFrom: null,
  });
  const failed = await admin(
    request(`${path}/versions/1/restore`, { draft: tokenOf(currentPage) }),
  );
  expect(failed.status).toBe(503);
  expect(await store.get(first.id)).toEqual(second);
  expect(JSON.stringify(logs)).not.toContain("private corrupt history");
  expect(
    logs.find(
      (entry) =>
        entry.requestId === failed.headers.get("x-request-id") &&
        entry.event === "operation.failed",
    ),
  ).toMatchObject({ code: "invalid_character", stage: "persona.restore" });
  bad.mockRestore();
  expect(
    (await admin(request(`${path}/versions/1/restore`, { draft: tokenOf(history) }))).status,
  ).toBe(409);
});

test("version navigation is locked during work and unsaved completed image previews remain recoverable", async () => {
  const { store, first, path } = await versionFixture();
  const portrait = deferred<typeof portraitImage>();
  const model = { ...generator, portrait: () => portrait.promise };
  const admin = createAdmin(store, "test-password", "", { generator: model, log: () => {} });
  const editor = await (await admin(request(path))).text();
  const queued = await admin(
    queuedRequest(`${path}?style=photo`, {
      name: first.name,
      description: first.description,
      published: "on",
      draft: tokenOf(editor),
      intent: "subportrait",
    }),
  );
  expect((await admin(request(`${path}/versions`))).status).toBe(409);
  portrait.resolve(portraitImage);
  const complete = await finishedJob(admin, jobUrl(queued));
  expect((await admin(request(`${path}/versions`))).status).toBe(409);
  expect(await (await admin(request(path))).text()).toContain("저장 전 미리보기");
  const convert = deferred<Awaited<ReturnType<typeof generator.convert>>>();
  const entered = deferred<void>();
  const freshAdmin = createAdmin(store, "test-password", "", {
    generator: {
      ...generator,
      convert: () => {
        entered.resolve();
        return convert.promise;
      },
    },
    log: () => {},
  });
  const pendingImprovement = freshAdmin(
    request(path, {
      name: first.name,
      description: first.description,
      published: "on",
      draft: tokenOf(editor),
      intent: "improve",
    }),
  );
  await entered.promise;
  expect((await freshAdmin(request(`${path}/versions`))).status).toBe(409);
  convert.resolve({ ...character, additions: [] });
  expect((await pendingImprovement).status).toBe(200);
  expect(complete).toContain('data-job-active="false"');
});
