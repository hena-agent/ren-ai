import { expect, test, vi } from "vitest";
import {
  character,
  fixture,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { savedPreview, preview, subGenerator } from "../test/sub-portraits.ts";
import { createAdmin } from "./admin.ts";
import { queuedRequest, jobUrl, finishedJob, deferred } from "../test/queue.ts";

test("stale saved edits cannot overwrite newer persona files and biography-only edits require an existing profile", async () => {
  const { admin, store, route, editing, original } = await savedPreview();
  await store.update({ ...original, name: "updated elsewhere" });
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(editing), intent: "save" }))).status,
  ).toBe(409);
  const { admin: empty } = await fixture();
  expect(
    (
      await empty(
        request("/personas", {
          ...character,
          draft: await newToken(empty),
          intent: "introduction",
        }),
      )
    ).status,
  ).toBe(400);
});

test("a character-writing operation owns the edit lock before image registration", async () => {
  const { promise: waiting, resolve: release } = deferred<typeof character>();
  const drafting = vi.fn<typeof generator.character>().mockReturnValue(waiting);
  const { admin } = await fixture({ ...subGenerator, character: drafting });
  const token = await newToken(admin);
  const running = admin(
    request("/personas", { draft: token, seed: "a new character", intent: "character" }),
  );
  await vi.waitFor(() => expect(drafting).toHaveBeenCalledTimes(1));
  expect(
    (await admin(queuedRequest("/personas", { ...character, draft: token, intent: "generate" })))
      .status,
  ).toBe(409);
  release(character);
  expect((await running).status).toBe(200);
});

test("replaying a failed legacy batch waits behind another live batch and retains its completed photo", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, editing, route } = await savedPreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("first failed batch"));
  const failedFields = { ...character, draft: tokenOf(editing), intent: "subportrait" };
  const failed = await admin(request(`${route}?style=photo`, failedFields));
  expect(failed.status).toBe(503);
  const partial = await failed.text();
  const { promise: waiting, resolve: release } = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(waiting);
  const second = await admin(
    queuedRequest(`${route}?style=anime`, {
      ...character,
      draft: tokenOf(partial),
      intent: "subportrait",
    }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(4));
  const replay = admin(request(`${route}?style=photo`, failedFields));
  await vi.waitFor(async () => {
    const current = await (await admin(request(jobUrl(second)))).text();
    expect(current).toContain("2번째");
  });
  release(portraitImage);
  expect((await replay).status).toBe(200);
  const done = await finishedJob(admin, jobUrl(second));
  expect(preview(done).secondaryPortraits).toHaveLength(2);
  expect((await store.get(preview(done).id)).secondaryPortraits).toBeUndefined();
});

test("blank photo-specific inputs use the default direction separately at one and multiple counts", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing } = await savedPreview({ ...subGenerator, portrait });
  const single = await admin(
    queuedRequest(
      `${route}?style=photo`,
      { ...character, draft: tokenOf(editing), intent: "subportrait", imageCount: "1" },
      [""],
    ),
  );
  const first = await finishedJob(admin, jobUrl(single));
  expect(portrait.mock.calls.at(-1)?.[2]).toBe("");
  const additional = await admin(
    queuedRequest(
      `${route}?style=photo`,
      { ...character, draft: tokenOf(first), intent: "subportrait", imageCount: "2" },
      ["", ""],
    ),
  );
  await finishedJob(admin, jobUrl(additional));
  expect(portrait.mock.calls.slice(-2).every((call) => Boolean(call[2]))).toBe(true);
  const initial = await admin(
    queuedRequest(
      "/personas",
      { ...character, draft: await newToken(admin), intent: "generate", imageCount: "2" },
      ["", "", "", ""],
    ),
  );
  await finishedJob(admin, jobUrl(initial));
  expect(portrait.mock.calls.slice(-2).every((call) => Boolean(call[2]))).toBe(true);
});

test("text-only generation without a provider keeps its editing form and reports configuration diagnostics", async () => {
  const { store } = await fixture();
  const admin = createAdmin(store, "test-password", "", { log: () => {} });
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      intent: "character",
      seed: "a private idea",
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("프로필 생성 API가 설정되지 않았습니다");
});

test("saved editors expose the active job on reload and legacy requests still receive a real stale-conflict status", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, route, original, editing } = await savedPreview({
    ...subGenerator,
    portrait,
  });
  const { promise: waiting, resolve: release } = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(waiting);
  const accepted = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  expect(await (await admin(request(route))).text()).toContain(
    `data-image-job="${jobUrl(accepted).split("/").at(-1)}"`,
  );
  const other = { ...original, id: "other-source" };
  await store.create(other);
  const otherRoute = `/personas/${other.id}`;
  const otherEditor = await (await admin(request(otherRoute))).text();
  const stale = admin(
    request(`${otherRoute}?style=photo`, {
      ...character,
      draft: tokenOf(otherEditor),
      intent: "subportrait",
    }),
  );
  await vi.waitFor(async () =>
    expect(await (await admin(request(otherRoute))).text()).toContain("IMAGE QUEUE"),
  );
  await store.update({ ...other, name: "Changed while queued" });
  release(portraitImage);
  expect((await stale).status).toBe(409);
  await finishedJob(admin, jobUrl(accepted));
});
