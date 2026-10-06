import { expect, test, vi } from "vitest";
import { character, generator, request, tokenOf } from "../test/fixtures.ts";
import { basePreview, preview, subGenerator } from "../test/sub-portraits.ts";

test("filling either missing main keeps the other style and creates no unnecessary reference read for one photo", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store } = await basePreview({ ...subGenerator, portrait });
  const original = preview(page);
  for (const missing of ["anime", "photo"] as const) {
    const other = missing === "anime" ? "photo" : "anime";
    const record = {
      ...original,
      imageUrl: original.portraits![other]!,
      portraits: { [other]: original.portraits![other]! },
    };
    if (missing === "anime") await store.create(record);
    else await store.update(record);
    const route = `/personas/${record.id}`;
    const editing = await (await admin(request(route))).text();
    const read = vi.spyOn(store, "image").mockResolvedValue(new Response(null, { status: 404 }));
    const added = await admin(
      request(`${route}?style=${missing}`, {
        ...character,
        draft: tokenOf(editing),
        intent: "subportrait",
      }),
    );
    expect(added.status).toBe(200);
    const after = preview(await added.text());
    expect(after.portraits?.[other]).toBe(record.portraits[other]);
    expect(after.imageUrl).toBe(after.portraits?.photo);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  }
});

test("missing-main batches preserve their first completed photo and stop when it cannot be read as an identity reference", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page, store, logs } = await basePreview({ ...subGenerator, portrait });
  const record = { ...preview(page), imageUrl: "" };
  delete record.portraits;
  await store.create(record);
  const route = `/personas/${record.id}`;
  const editing = await (await admin(request(route))).text();
  const read = vi.spyOn(store, "image").mockResolvedValue(new Response(null, { status: 404 }));
  const failed = await admin(
    request(`${route}?style=anime`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
      imageCount: "2",
    }),
  );
  expect(failed.status).toBe(503);
  const partial = preview(await failed.text());
  expect(partial.portraits?.anime).toBeTruthy();
  expect(partial.portraits?.photo).toBeUndefined();
  expect(partial.imageUrl).toBe(partial.portraits?.anime);
  expect(partial.secondaryPortraits).toBeUndefined();
  expect(portrait).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    logs.find(
      (entry) =>
        entry.requestId === failed.headers.get("x-request-id") &&
        entry.event === "operation.failed",
    ),
  ).toMatchObject({
    style: "anime",
    stage: "portrait.reference.read",
    code: "reference_unavailable",
  });
});
