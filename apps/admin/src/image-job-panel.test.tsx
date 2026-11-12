import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useBrowser } from "../test/browser.ts";
import { savedPreview, subGenerator } from "../test/sub-portraits.ts";
import { createImageBatch } from "./image-batch.ts";
import { ImageJobPanel } from "./image-job-panel.tsx";
import type { ImageJob } from "./image-queue.ts";
import { serializePersona } from "@ren-ai/personas";
import copy from "./copy.json";
import { renderPage } from "./page.tsx";
import { seedreamModel } from "../test/image-models.ts";

useBrowser();

test("face generation history and retries identify the facial action rather than a replacement body", async () => {
  const job = await jobFixture();
  const snapshot = job.batch.snapshot();
  const faceJob: ImageJob = {
    ...job,
    state: "failed",
    batch: {
      ...job.batch,
      intent: "rig-artwork",
      snapshot: () => ({
        ...snapshot,
        original: {
          ...snapshot.original,
          rigArtwork: {
            model: seedreamModel.id,
            selection: seedreamModel,
            target: "body",
            face: { kind: "closed", sourceLayerImageUrl: "/images/face.png" },
          },
        },
      }),
    },
  };
  document.body.innerHTML = renderToStaticMarkup(
    <ImageJobPanel job={faceJob} position={0} now={7500} />,
  );
  expect(document.querySelector(".queue-item-content > strong")!.textContent).toContain(
    "얼굴 · 감긴 눈·미소",
  );
  expect(
    document.querySelector<HTMLButtonElement>('[value="retry-image"]')!.dataset["rigFaceAction"],
  ).toBe("closed");
});

async function jobFixture() {
  const { original, store } = await savedPreview();
  const batch = createImageBatch(
    original,
    {
      id: original.id,
      base: serializePersona(original),
      preview: serializePersona(original),
      imageCount: 4,
      sheets: await store.sheets(original.id),
      imagePrompts: ["photo one", "photo two", "failed prompt", "blocked prompt"],
    },
    "generate",
    new URLSearchParams({ style: "photo" }),
    "generate:photo",
    subGenerator,
    store,
  );
  const job: ImageJob = {
    id: "job-identifier",
    batch,
    state: "running",
    requestId: "batch-request",
    queuedAt: 1000,
    tasks: [
      {
        style: "photo",
        index: 1,
        ordinal: 0,
        state: "completed",
        imageUrl: "https://example.net/discovery/images/external.jpg",
        startedAt: 1000,
        durationMs: 2500,
      },
      { style: "photo", index: 2, ordinal: 1, state: "generating", startedAt: 3000 },
      {
        style: "anime",
        index: 0,
        ordinal: 2,
        state: "failed",
        requestId: "photo-request",
        startedAt: 4000,
        durationMs: 0,
      },
      { style: "photo", index: 3, ordinal: 3, state: "blocked" },
    ],
  };
  return job;
}

test("outfit layer failures identify the asset and retain the existing-result recovery action", async () => {
  const job = await jobFixture();
  const snapshot = job.batch.snapshot();
  const failed: ImageJob = {
    ...job,
    state: "failed",
    batch: {
      ...job.batch,
      intent: "rig-layers",
      snapshot: () => ({
        ...snapshot,
        layerize: { requestId: "known-provider-request", saved: [] },
        original: { ...snapshot.original, rigArtwork: { model: "fal:test", target: "outfit" } },
      }),
    },
  };
  document.body.innerHTML = renderToStaticMarkup(
    <ImageJobPanel job={failed} position={0} now={7500} />,
  );
  expect(document.querySelector(".queue-item-content > strong")!.textContent).toContain(
    "의상 레이어 분리",
  );
  const retry = document.querySelector<HTMLButtonElement>('[value="retry-image"]')!;
  expect(retry.dataset["artworkTarget"]).toBe("outfit");
  expect(retry.dataset["layerizeCached"]).toBe("true");
});

test("progress reports each real state, counter, elapsed seconds, accessible labels and original diagnostic correlation", async () => {
  const job = await jobFixture();
  document.body.innerHTML = renderToStaticMarkup(
    <ImageJobPanel job={job} position={0} now={7500} />,
  );
  expect(document.querySelector(".queue-count")?.textContent).toBe("1 / 4");
  expect(document.querySelector(".queue-totals small")?.textContent).toBe("6초 경과");
  expect(document.querySelector("#image-queue-title")?.getAttribute("tabindex")).toBe("-1");
  const rows = document.querySelectorAll("li");
  expect(rows[0]!.querySelector("strong")!.textContent).toBe("실사 사진 2");
  expect(rows[0]!.querySelector("span")!.textContent).toBe("완료 · 2초");
  expect(rows[0]!.querySelector("img")!.getAttribute("src")).toBe(
    "https://example.net/discovery/images/external.jpg",
  );
  expect(rows[0]!.querySelector("img")!.getAttribute("alt")).toBe("실사 사진 2");
  expect(rows[0]!.querySelector(".queue-request-id")).toBeNull();
  expect(rows[1]!.querySelector(".queue-thumbnail span")!.textContent).toBe("2");
  expect(rows[1]!.querySelector(".queue-item-content span")!.textContent).toBe(
    "이미지 생성 중 · 4초",
  );
  expect(rows[2]!.querySelector("small")!.textContent).toBe("요청 ID: photo-request");
  expect(rows[2]!.querySelector(".queue-item-content span")!.textContent).toBe("실패 · 0초");
  expect(rows[3]!.querySelector("small")!.textContent).toBe("요청 ID: batch-request");
  expect(rows[3]!.querySelector(".queue-item-content span")!.textContent).toBe(
    copy.queueStates.blocked,
  );
  expect(document.querySelectorAll('[value="retry-image"]')).toHaveLength(0);
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe(copy.queueRunning);
});

test("queued and finished displays use truthful waiting time and only retry failed rows with their own prompt", async () => {
  const job = await jobFixture();
  job.state = "queued";
  document.body.innerHTML = renderToStaticMarkup(
    <ImageJobPanel job={job} position={2} now={9500} />,
  );
  expect(document.querySelector("[data-job-active]")?.getAttribute("data-job-active")).toBe("true");
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe(
    `${copy.queueWaiting} · 3번째`,
  );
  expect(document.querySelector(".queue-totals small")?.textContent).toBe("8초 경과");
  expect(document.querySelectorAll("button")).toHaveLength(0);
  job.state = "failed";
  job.finishedAt = 8000;
  job.tasks[0]!.imageUrl = "https://persona-images.renai.im/owned.jpg";
  document.body.innerHTML = renderToStaticMarkup(
    <ImageJobPanel job={job} position={-1} now={15000} />,
  );
  expect(document.querySelector("[data-job-active]")?.getAttribute("data-job-active")).toBe(
    "false",
  );
  expect(document.querySelector("[data-queue-status]")?.textContent).toContain("실패한 사진");
  expect(document.querySelector(".queue-totals small")?.textContent).toBe("7초 경과");
  expect(document.querySelector("img")?.getAttribute("src")).toBe(
    "https://persona-images.renai.im/owned.jpg",
  );
  const buttons = document.querySelectorAll<HTMLButtonElement>('[value="retry-image"]');
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.getAttribute("formaction")).toBe("/image-jobs/job-identifier/retry?image=2");
  expect(buttons[0]?.dataset["portraitOperation"]).toBe("retry:job-identifier:2");
  expect(buttons[0]?.dataset["portraitLabel"]).toBe("애니메 사진 1 · 이미지 1장 생성");
  expect(buttons[0]?.dataset["portraitPrompt"]).toBe("failed prompt");
  expect(buttons[1]?.dataset["portraitPrompt"]).toBe("blocked prompt");
  expect(buttons[0]?.textContent).toBe(copy.retryImage);
  expect(buttons[0]?.getAttribute("form")).toBe("persona-editor");
});

test("the single-job editor remains renderable with a stable progress heading and locked source", async () => {
  const job = await jobFixture();
  job.state = "queued";
  document.body.innerHTML = renderPage({
    record: job.batch.source,
    editing: true,
    draft: "signed",
    imageJob: job,
    queuePosition: 0,
    queueObservedAt: 5000,
  });
  expect(document.querySelectorAll("#image-queue-title")).toHaveLength(1);
  expect(document.querySelector('[name="description"]')!.hasAttribute("readonly")).toBe(true);
});

test("finishing the selected batch does not unlock its editor while another batch remains queued", async () => {
  const job = await jobFixture();
  job.state = "completed";
  const waiting: ImageJob = { ...job, id: "waiting-batch", state: "queued" };
  document.body.innerHTML = renderPage({
    record: job.batch.source,
    editing: true,
    draft: "signed",
    imageJob: job,
    imageJobs: [
      { job, position: -1 },
      { job: waiting, position: 0 },
    ],
    queueObservedAt: 5000,
  });
  expect(document.querySelector('[name="description"]')!.hasAttribute("readonly")).toBe(true);
  expect(document.querySelector('[value="save"]')!.hasAttribute("disabled")).toBe(true);
  expect(document.querySelectorAll('[data-job-active="true"]')).toHaveLength(1);
});
