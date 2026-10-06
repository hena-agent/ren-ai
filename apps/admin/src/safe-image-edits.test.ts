import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import { draftTokens } from "./draft.ts";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, preview, subGenerator, publishPreview } from "../test/sub-portraits.ts";

test("save and reload restore only actual edits, and a replayed successful addition returns a successful latest preview", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const addedFields = { ...character, draft: tokenOf(page), intent: "subportrait" };
  const added = await admin(request("/personas?style=photo", addedFields));
  expect(added.status).toBe(200);
  const content = await added.text();
  const saved = await publishPreview(admin, content);
  expect(saved.status).toBe(303);
  const route = `/personas/${preview(content).id}`;
  const current = await (await admin(request(route))).text();
  const photo = preview(current).portraits!.photo!;
  const replacement = await admin(
    request(`${route}?style=photo&image=${encodeURIComponent(photo)}`, {
      ...character,
      draft: tokenOf(current),
      intent: "regenerate",
    }),
  );
  expect(replacement.status).toBe(200);
  const replaced = await replacement.text();
  expect(preview(await (await admin(request(route))).text())).toEqual(preview(replaced));
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(replaced), published: "on" })))
      .status,
  ).toBe(303);
  expect(preview(await (await admin(request(route))).text())).toEqual(
    await store.get(preview(content).id),
  );
  const replay = await admin(request("/personas?style=photo", addedFields));
  expect(replay.status).toBe(200);
  expect(preview(await replay.text())).toEqual(await store.get(preview(content).id));
  expect(portrait).toHaveBeenCalledTimes(4);
});

test("changed source blocks deletion, addition and biography-only work before provider or saved-state changes", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const introduction = vi
    .fn<typeof generator.introduction>()
    .mockImplementation(generator.introduction);
  const { admin, page } = await basePreview({ ...subGenerator, portrait, introduction });
  const main = preview(page).portraits!.photo!;
  for (const [intent, path] of [
    ["delete-image", `/personas?style=photo&image=${encodeURIComponent(main)}`],
    ["subportrait", "/personas?style=photo"],
    ["introduction", "/personas"],
  ] as const) {
    expect(
      (
        await admin(
          request(path, {
            ...character,
            description: "modified source",
            draft: tokenOf(page),
            intent,
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect(portrait).toHaveBeenCalledTimes(2);
  expect(introduction).toHaveBeenCalledTimes(1);
});

test("a failed multi-image addition displays recovery information, preserves successes and permits a same-input retry", async () => {
  const model = {
    ...subGenerator,
    portrait: vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait),
  };
  const { admin, page } = await basePreview(model);
  model.portrait.mockRejectedValueOnce(new Error("outage"));
  const fields = { ...character, draft: tokenOf(page), intent: "subportrait", imageCount: "2" };
  const failed = await admin(request("/personas?style=photo", fields));
  expect(failed.status).toBe(503);
  const result = await failed.text();
  expect(result).toContain("완성된 사진은 미리보기에 보존");
  expect(result).toContain("요청 ID:");
  expect(preview(result).secondaryPortraits).toHaveLength(1);
  const retried = await admin(request("/personas?style=photo", fields));
  expect(retried.status).toBe(200);
  expect(preview(await retried.text()).secondaryPortraits).toHaveLength(2);
});

test("private image directions are bounded and narrowed before requests, and whitespace is trimmed", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  expect(
    (
      await admin(
        request("/personas?style=photo", {
          ...character,
          draft: tokenOf(page),
          intent: "subportrait",
          imageDirection: "x".repeat(4001),
        }),
      )
    ).status,
  ).toBe(400);
  const body = new FormData();
  for (const [key, value] of Object.entries({
    ...character,
    draft: tokenOf(page),
    intent: "subportrait",
  }))
    body.set(key, value);
  body.set("imageDirection", new File(["bad"], "direction.txt"));
  const original = request("/personas?style=photo");
  const file = await admin(
    new Request(original.url, { method: "POST", headers: original.headers, body }),
  );
  expect(file.status).toBe(400);
  expect(
    (
      await admin(
        request("/personas?style=photo", {
          ...character,
          draft: tokenOf(page),
          intent: "subportrait",
          imageDirection: "  a casual selfie  ",
        }),
      )
    ).status,
  ).toBe(200);
  expect(portrait.mock.calls.at(-1)?.[2]).toBe("a casual selfie");
  expect(portrait).toHaveBeenCalledTimes(3);
});

test("biography-only recovery never consumes images and malformed saved hints are ignored", async () => {
  const intro = vi.fn<typeof generator.introduction>().mockImplementation(generator.introduction);
  const { admin, store, page } = await basePreview({ ...subGenerator, introduction: intro });
  const saved = await publishPreview(admin, page);
  expect(saved.status).toBe(303);
  const route = `/personas/${preview(page).id}`;
  const current = await (await admin(request(route))).text();
  const rewritten = await (
    await admin(request(route, { ...character, draft: tokenOf(current), intent: "introduction" }))
  ).text();
  expect((await admin(request(route, { ...character, draft: tokenOf(rewritten) }))).status).toBe(
    303,
  );
  expect((await store.get(preview(page).id)).bio).toBe(preview(rewritten).bio);
  expect(draftTokens("test-password").decode(tokenOf(rewritten))).not.toHaveProperty(
    "recommendation",
  );
  const restart = createAdmin(store, "test-password", "", {
    generator: subGenerator,
    log: () => {},
  });
  expect((await restart(request(route))).status).toBe(200);
});
