import { expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import type { HTMLTextAreaElement } from "happy-dom";
import { personaImages } from "@ren-ai/personas";
import {
  character,
  fixture,
  generator,
  newToken,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { preview, subGenerator, basePreview } from "../test/sub-portraits.ts";
import { queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";

test("all personas and styles share one FIFO worker, with early acknowledgement, per-image prompts and live saved previews", async () => {
  const release: ((image: typeof portraitImage) => void)[] = [];
  let active = 0;
  let maximum = 0;
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(() => {
    active++;
    maximum = Math.max(maximum, active);
    return new Promise((resolve) =>
      release.push((image) => {
        active--;
        resolve(image);
      }),
    );
  });
  const { admin, store, logs } = await fixture({ ...generator, portrait });
  const firstDraft = await newToken(admin);
  const firstFields = { ...character, draft: firstDraft, intent: "generate", imageCount: "1" };
  const first = await admin(
    queuedRequest("/personas", firstFields, ["private anime selfie", "private realistic travel"]),
  );
  expect(first.status).toBe(303);
  const path = jobUrl(first);
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(1));
  expect(portrait.mock.calls[0]?.slice(1)).toEqual(["anime", "private anime selfie"]);
  const duplicate = await admin(
    queuedRequest("/personas", firstFields, ["private anime selfie", "private realistic travel"]),
  );
  expect(jobUrl(duplicate)).toBe(path);
  const second = await admin(
    queuedRequest(
      "/personas",
      {
        ...character,
        name: "Second",
        draft: await newToken(admin),
        intent: "generate",
        imageCount: "1",
      },
      ["second anime", "second photo"],
    ),
  );
  expect(second.status).toBe(303);
  const waiting = await (await admin(request(jobUrl(second)))).text();
  expect(waiting).not.toContain(`data-image-job="${path.split("/").at(-1)}"`);
  expect(waiting).toContain("2번째");
  expect(portrait).toHaveBeenCalledTimes(1);
  const current = await (await admin(request(path))).text();
  expect(current).not.toContain(`data-image-job="${jobUrl(second).split("/").at(-1)}"`);
  expect(current).toContain('data-state="generating"');
  expect(current).toContain('data-state="waiting"');
  const window = new Window();
  try {
    window.document.body.innerHTML = current;
    expect(window.document.querySelector("#name")?.hasAttribute("readonly")).toBe(true);
    expect(window.document.querySelector('button[value="save"]')?.hasAttribute("disabled")).toBe(
      true,
    );
  } finally {
    await window.happyDOM.close();
  }
  expect(
    (await admin(request("/personas", { ...character, draft: firstDraft, intent: "save" }))).status,
  ).toBe(409);
  release[0]!(portraitImage);
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(2));
  const partial = await (await admin(request(path))).text();
  expect(personaImages(preview(partial))).toHaveLength(1);
  expect(partial).toContain('data-state="completed"');
  expect(portrait.mock.calls[1]?.slice(1)).toEqual(["photo", "private realistic travel"]);
  release[1]!(portraitImage);
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  release[2]!(portraitImage);
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(4));
  release[3]!(portraitImage);
  const done = await finishedJob(admin, path);
  await finishedJob(admin, jobUrl(second));
  expect(maximum).toBe(1);
  expect(personaImages(preview(done))).toHaveLength(2);
  expect(await store.publicList()).toEqual([]);
  expect(await store.list()).toEqual([]);
  const requestId = first.headers.get("x-request-id");
  expect(
    logs
      .filter(
        (entry) => entry.jobId === path.split("/").at(-1) && entry.stage === "portrait.generate",
      )
      .every((entry) => entry.requestId === requestId),
  ).toBe(true);
  for (const privateValue of [
    "private anime selfie",
    "private realistic travel",
    character.description,
    firstDraft,
  ])
    expect(JSON.stringify(logs)).not.toContain(privateValue);
});

test("adding two photos sends each independent instruction once, keeps the approved main and retries only one failed slot", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, store, page, logs } = await basePreview({ ...subGenerator, portrait });
  const original = preview(page);
  portrait.mockRejectedValueOnce(new Error("first private idea provider failure"));
  const fields = { ...character, draft: tokenOf(page), intent: "subportrait", imageCount: "2" };
  const accepted = await admin(
    queuedRequest("/personas?style=photo", fields, ["first private idea", "second private idea"]),
  );
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  const result = preview(partial);
  expect(result.portraits).toEqual(original.portraits);
  expect(result.secondaryPortraits).toHaveLength(1);
  expect(portrait.mock.calls.slice(2).map((call) => call[2])).toEqual([
    "first private idea",
    "second private idea",
  ]);
  const replay = await admin(
    queuedRequest("/personas?style=photo", fields, ["first private idea", "second private idea"]),
  );
  expect(jobUrl(replay)).toBe(path);
  expect(portrait).toHaveBeenCalledTimes(4);
  const retry = await admin(
    queuedRequest(`${path}/retry?image=0`, {
      ...character,
      draft: tokenOf(partial),
      intent: "retry-image",
      imageCount: "1",
      portraitInstructions: "changed retry idea",
    }),
  );
  expect(retry.status).toBe(303);
  const recovered = await finishedJob(admin, path);
  expect(preview(recovered).secondaryPortraits).toHaveLength(2);
  expect(preview(recovered).secondaryPortraits?.[0]?.imageUrl).toBe(
    result.secondaryPortraits?.[0]?.imageUrl,
  );
  expect(portrait).toHaveBeenCalledTimes(5);
  expect(portrait.mock.calls.at(-1)?.[2]).toBe("changed retry idea");
  expect(await store.publicList()).toEqual([]);
  const failure = logs.find(
    (entry) =>
      entry.event === "operation.failed" &&
      entry.requestId === accepted.headers.get("x-request-id"),
  );
  expect(failure?.jobId).toBe(path.split("/").at(-1));
  expect(failure?.imageOrdinal).toBe(0);
  expect(failure?.style).toBe("photo");
  expect(failure?.error?.message).not.toContain("first private idea");
  const retryFailures = await admin(
    queuedRequest(`${path}/retry?image=1`, {
      ...character,
      draft: tokenOf(recovered),
      portraitInstructions: "don't charge completed",
    }),
  );
  expect(retryFailures.status).toBe(400);
  expect(portrait).toHaveBeenCalledTimes(5);
});

test("a second failure keeps the edited prompt on only its failed photo for the next confirmed retry", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, page } = await basePreview({ ...subGenerator, portrait });
  portrait.mockRejectedValueOnce(new Error("first failure"));
  const accepted = await admin(
    queuedRequest(
      "/personas?style=photo",
      { ...character, draft: tokenOf(page), intent: "subportrait", imageCount: "2" },
      ["first prompt", "completed sibling"],
    ),
  );
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  portrait.mockRejectedValueOnce(new Error("another failure"));
  const retry = await admin(
    queuedRequest(`${path}/retry?image=0`, {
      ...character,
      draft: tokenOf(partial),
      portraitInstructions: "edited failed prompt",
    }),
  );
  expect(retry.status).toBe(303);
  const failed = await finishedJob(admin, path);
  const window = new Window();
  try {
    window.document.body.innerHTML = failed;
    expect(
      [...window.document.querySelectorAll<HTMLTextAreaElement>("dialog textarea")].map(
        (input) => input.value,
      ),
    ).toEqual(["edited failed prompt", "completed sibling"]);
  } finally {
    await window.happyDOM.close();
  }
  expect(preview(failed).secondaryPortraits).toHaveLength(1);
  expect(portrait).toHaveBeenCalledTimes(5);
});

test("invalid per-image counts, uploaded prompts and unauthorized queue routes cannot reach paid generation", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin } = await fixture({ ...subGenerator, portrait });
  const fields = {
    ...character,
    draft: await newToken(admin),
    intent: "generate",
    imageCount: "2",
  };
  expect((await admin(queuedRequest("/personas", fields, ["only one"]))).status).toBe(400);
  expect(
    (await admin(queuedRequest("/personas", fields, ["a", "b", "c", "x".repeat(4001)]))).status,
  ).toBe(400);
  const body = new FormData();
  for (const [key, value] of Object.entries({
    ...fields,
    imageCount: "1",
    separateImagePrompts: "1",
    portraitInstructions: "valid",
  }))
    body.set(key, value);
  body.set("imagePrompts", new File(["not a prompt"], "prompt.txt"));
  expect((await admin(new Request(request("/personas"), { method: "POST", body }))).status).toBe(
    400,
  );
  const missing = request("/image-jobs/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  missing.headers.delete("authorization");
  expect((await admin(missing)).status).toBe(401);
  expect((await admin(request(missing.url.replace("http://localhost:3729", "")))).status).toBe(404);
  expect(portrait).not.toHaveBeenCalled();
});

test("first-style failures block dependent photos while the other style proceeds, and a row retry creates only that failed main", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  portrait.mockRejectedValueOnce(new Error("anime main failed"));
  const { admin } = await fixture({ ...subGenerator, portrait });
  const accepted = await admin(
    queuedRequest(
      "/personas",
      { ...character, draft: await newToken(admin), intent: "generate", imageCount: "2" },
      ["anime main", "photo main", "anime extra", "photo extra"],
    ),
  );
  const path = jobUrl(accepted);
  const partial = await finishedJob(admin, path);
  expect(partial).toContain('data-state="blocked"');
  expect(portrait.mock.calls.map((call) => call[2])).toEqual([
    "anime main",
    "photo main",
    "photo extra",
  ]);
  const before = preview(partial);
  expect(before.portraits?.anime).toBeUndefined();
  expect(before.secondaryPortraits).toHaveLength(1);
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=0`, {
          ...character,
          draft: tokenOf(partial),
          portraitInstructions: "anime main retry",
        }),
      )
    ).status,
  ).toBe(303);
  const main = await finishedJob(admin, path);
  expect(portrait).toHaveBeenCalledTimes(4);
  expect(preview(main).portraits?.photo).toBe(before.portraits?.photo);
  expect(preview(main).secondaryPortraits).toEqual(before.secondaryPortraits);
  expect(
    (
      await admin(
        queuedRequest(`${path}/retry?image=2`, {
          ...character,
          draft: tokenOf(main),
          portraitInstructions: "anime extra retry",
        }),
      )
    ).status,
  ).toBe(303);
  const done = await finishedJob(admin, path);
  expect(portrait).toHaveBeenCalledTimes(5);
  expect(preview(done).secondaryPortraits).toHaveLength(2);
  expect(done).not.toContain('data-state="blocked"');
});
