import { expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { character, generator, portraitImage, request, tokenOf } from "../test/fixtures.ts";
import { preview, savedPreview, subGenerator } from "../test/sub-portraits.ts";
import { deferred, finishedJob, jobUrl, queuedRequest } from "../test/queue.ts";
import { createAdmin } from "./admin.ts";
import { randomUUID } from "node:crypto";

async function waitingEditor() {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const setup = await savedPreview({ ...subGenerator, portrait });
  const wait = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(wait.promise);
  return { ...setup, portrait, wait };
}

test("one persona accepts multiple FIFO batches, reserves capacity, and merges each completed photo without publishing", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing, store, original, logs } = await savedPreview({
    ...subGenerator,
    portrait,
  });
  const wait = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(wait.promise);
  const enqueue = (prompt: string, count: string) =>
    admin(
      queuedRequest(`${route}?style=photo`, {
        ...character,
        draft: tokenOf(editing),
        intent: "subportrait",
        imageCount: count,
        portraitInstructions: prompt,
      }),
    );
  const first = await enqueue("first queued photo", "2");
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  const second = await enqueue("next queued photo", "3");
  expect(second.status).toBe(303);
  const replacement = await admin(
    queuedRequest(`${route}?style=photo&image=${encodeURIComponent(original.portraits!.photo!)}`, {
      ...character,
      draft: tokenOf(editing),
      intent: "regenerate",
    }),
  );
  expect(replacement.status).toBe(303);
  expect(
    (
      await admin(
        queuedRequest(route, {
          ...character,
          draft: tokenOf(editing),
          intent: "generate",
          portraitInstructions: "replace the whole profile",
        }),
      )
    ).status,
  ).toBe(409);
  const rejected = await enqueue("over capacity", "1");
  expect(rejected.status).toBe(400);
  const recovery = await rejected.text();
  expect(recovery).toContain('data-queue-locked="true"');
  expect(recovery).toMatch(/readonly=""/i);
  expect(recovery).toContain(`data-image-job="${jobUrl(replacement).split("/").at(-1)}"`);
  const page = await (await admin(request(jobUrl(second)))).text();
  const window = new Window();
  try {
    window.document.body.innerHTML = page;
    expect(window.document.querySelectorAll('[data-job-active="true"]')).toHaveLength(3);
    const headings = [...window.document.querySelectorAll(".image-queue h2")].map(
      (heading) => heading.id,
    );
    expect(headings.every(Boolean)).toBe(true);
    expect(new Set(headings).size).toBe(3);
    expect(
      [...window.document.querySelectorAll(".queue-items strong")].map(
        (label) => label.textContent,
      ),
    ).toEqual([
      "실사 사진 2",
      "실사 사진 3",
      "실사 사진 4",
      "실사 사진 5",
      "실사 사진 6",
      "실사 사진 1",
    ]);
    expect(
      window.document
        .querySelector('[data-portrait-operation="subportrait:photo"]')!
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      window.document
        .querySelector('[data-portrait-operation="subportrait:anime"]')!
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(window.document.querySelector('[value="regenerate"]')!.hasAttribute("disabled")).toBe(
      false,
    );
    expect(window.document.querySelector('[value="save"]')!.hasAttribute("disabled")).toBe(true);
    expect(window.document.querySelector('[name="name"]')!.hasAttribute("readonly")).toBe(true);
  } finally {
    await window.happyDOM.close();
  }
  expect(
    (await admin(request(route, { ...character, draft: tokenOf(page), intent: "save" }))).status,
  ).toBe(409);
  expect(portrait).toHaveBeenCalledTimes(3);
  wait.resolve(portraitImage);
  await finishedJob(admin, jobUrl(first));
  await finishedJob(admin, jobUrl(replacement));
  const done = await finishedJob(admin, jobUrl(second));
  const images = preview(done).secondaryPortraits!;
  expect(images).toHaveLength(5);
  expect(new Set(images.map((image) => image.imageUrl)).size).toBe(5);
  expect(portrait.mock.calls.slice(2, 7).map((call) => call[2])).toEqual([
    expect.stringContaining("first queued photo"),
    expect.stringContaining("first queued photo"),
    expect.stringContaining("next queued photo"),
    expect.stringContaining("next queued photo"),
    expect.stringContaining("next queued photo"),
  ]);
  expect(portrait.mock.calls.slice(2, 7).every((call) => call[3]?.bytes.length)).toBe(true);
  expect(await store.get(original.id)).toEqual(original);
  expect(
    logs
      .filter((entry) => entry.event === "image.queue.completed")
      .every((entry) => entry.outcome === "completed"),
  ).toBe(true);
});

test("queued replacements validate their original target before payment and cannot undo a completed sibling", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(subGenerator.portrait);
  const { admin, route, editing, original } = await savedPreview({ ...subGenerator, portrait });
  const wait = deferred<typeof portraitImage>();
  portrait.mockReturnValueOnce(wait.promise);
  const target = `${route}?style=photo&image=${encodeURIComponent(original.portraits!.photo!)}`;
  const fields = { ...character, draft: tokenOf(editing), intent: "regenerate" };
  const first = await admin(queuedRequest(target, { ...fields, portraitInstructions: "first" }));
  await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
  const second = await admin(queuedRequest(target, { ...fields, portraitInstructions: "second" }));
  expect(second.status).toBe(303);
  wait.resolve(portraitImage);
  const completed = await finishedJob(admin, jobUrl(first));
  const failed = await finishedJob(admin, jobUrl(second));
  expect(portrait).toHaveBeenCalledTimes(3);
  expect(preview(failed).portraits).toEqual(preview(completed).portraits);
  expect(preview(failed).portraits!.photo).not.toBe(original.portraits!.photo);
  expect(failed).toContain('data-state="blocked"');
});

test.each(["anime", "photo"] as const)(
  "%s reservations reject overflow before payment while keeping the full accepted batch",
  async (style) => {
    const { admin, route, editing, portrait, wait } = await waitingEditor();
    const fields = { ...character, draft: tokenOf(editing), intent: "subportrait" };
    const first = await admin(
      queuedRequest(`${route}?style=${style}`, { ...fields, imageCount: "5" }),
    );
    await vi.waitFor(() => expect(portrait).toHaveBeenCalledTimes(3));
    expect(
      (await admin(queuedRequest(`${route}?style=${style}`, { ...fields, imageCount: "1" })))
        .status,
    ).toBe(400);
    expect(portrait).toHaveBeenCalledTimes(3);
    wait.resolve(portraitImage);
    const completed = await finishedJob(admin, jobUrl(first));
    expect(preview(completed).secondaryPortraits).toHaveLength(5);
    expect(portrait).toHaveBeenCalledTimes(7);
  },
);

test("a valid signed editor from before an Admin restart can register and display a waiting batch", async () => {
  const { store, route, editing } = await savedPreview();
  const wait = deferred<typeof portraitImage>();
  const portrait = vi.fn<typeof generator.portrait>().mockReturnValueOnce(wait.promise);
  const admin = createAdmin(store, "test-password", "", {
    generator: { ...subGenerator, portrait },
    log: () => {},
  });
  const accepted = await admin(
    queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    }),
  );
  const pending = await (await admin(request(jobUrl(accepted)))).text();
  expect(preview(pending).name).toBe(character.name);
  expect(pending).toContain('data-job-active="true"');
  wait.resolve(portraitImage);
  expect(preview(await finishedJob(admin, jobUrl(accepted))).secondaryPortraits).toHaveLength(1);
});

test("separate confirmations can queue identical photo options while an acknowledged request replay remains free", async () => {
  const { admin, route, editing, portrait, wait } = await waitingEditor();
  const firstId = randomUUID();
  const submit = (id: string) => {
    const submission = queuedRequest(`${route}?style=photo`, {
      ...character,
      draft: tokenOf(editing),
      intent: "subportrait",
    });
    submission.headers.set("X-Image-Request", id);
    return admin(submission);
  };
  const first = await submit(firstId);
  const second = await submit(randomUUID());
  expect(jobUrl(second)).not.toBe(jobUrl(first));
  expect(jobUrl(await submit(firstId))).toBe(jobUrl(first));
  expect((await submit("invalid request id")).status).toBe(400);
  expect((await submit(`prefix${firstId}`)).status).toBe(400);
  expect((await submit(`${firstId}suffix`)).status).toBe(400);
  wait.resolve(portraitImage);
  await finishedJob(admin, jobUrl(first));
  const completed = await finishedJob(admin, jobUrl(second));
  expect(preview(completed).secondaryPortraits).toHaveLength(2);
  expect(portrait).toHaveBeenCalledTimes(4);
});
