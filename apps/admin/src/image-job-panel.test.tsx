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

useBrowser();

async function jobFixture() {
  const { original, store } = await savedPreview();
  const batch = createImageBatch(
    original,
    {
      id: original.id,
      base: serializePersona(original),
      preview: serializePersona(original),
      imageCount: 4,
      imagePrompts: ["photo one", "photo two", "failed prompt", "blocked prompt"],
    },
    "subportrait",
    new URLSearchParams({ style: "photo" }),
    "subportrait:photo",
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
  expect(rows[0]!.querySelector("small")).toBeNull();
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
  job.tasks[0]!.imageUrl = "/discovery/images/owned.jpg";
  document.body.innerHTML = renderToStaticMarkup(
    <ImageJobPanel job={job} position={-1} now={15000} />,
  );
  expect(document.querySelector("[data-job-active]")?.getAttribute("data-job-active")).toBe(
    "false",
  );
  expect(document.querySelector("[data-queue-status]")?.textContent).toBe(copy.queueFinished);
  expect(document.querySelector(".queue-totals small")?.textContent).toBe("7초 경과");
  expect(document.querySelector("img")?.getAttribute("src")).toBe("/images/owned.jpg");
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
