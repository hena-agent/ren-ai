import { expect, test } from "vitest";
import { generateImage } from "./image-generation.ts";
import { regeneratePortrait } from "./regenerate-portrait.ts";
import { readPortraitReference } from "./portrait-images.ts";
import { loggedRequest } from "./logging.ts";
import type { LogEntry } from "./logging.ts";
import { serializePersona } from "@ren-ai/personas";
import { savedPreview, subGenerator } from "../test/sub-portraits.ts";
import { request } from "../test/fixtures.ts";

test("image generation and storage carry their own style and optional picture index at an independent operation boundary", async () => {
  const { original, store } = await savedPreview();
  const logs: LogEntry[] = [];
  await loggedRequest(
    request("/personas", { intent: "generate" }),
    async () => {
      await generateImage(original, "anime", subGenerator, store, "", undefined, 3);
      return new Response();
    },
    (entry) => logs.push(entry),
  );
  expect(
    logs
      .filter((entry) => entry.event === "operation.started")
      .map((entry) => [entry.stage, entry.style, entry.poseIndex]),
  ).toEqual([
    ["portrait.generate", "anime", 3],
    ["image.save", "anime", 3],
  ]);
});

test("independent regeneration emits generating and saving stages and maintains its selected style diagnostics", async () => {
  const { original, store } = await savedPreview();
  const stages: string[] = [];
  const logs: LogEntry[] = [];
  const draft = {
    id: original.id,
    base: serializePersona(original),
    preview: serializePersona(original),
    imageInstructions: "",
  };
  await loggedRequest(
    request("/personas", { intent: "regenerate" }),
    async () => {
      await regeneratePortrait(
        original,
        draft,
        new URLSearchParams({ style: "photo", image: "0" }),
        `photo:${original.portraits!.photo!}`,
        subGenerator,
        store,
        (stage) => stages.push(stage),
      );
      return new Response();
    },
    (entry) => logs.push(entry),
  );
  expect(stages).toEqual(["generating", "saving"]);
  expect(logs.find((entry) => entry.stage === "portrait.generate")).toMatchObject({
    style: "photo",
    poseIndex: 0,
  });
});

test("reference reads retain style diagnostics without relying on an enclosing queue-task context", async () => {
  const { original, store } = await savedPreview();
  const logs: LogEntry[] = [];
  await loggedRequest(
    request("/images/example"),
    async () => {
      await readPortraitReference(original.portraits!.anime!, "anime", store);
      return new Response();
    },
    (entry) => logs.push(entry),
  );
  expect(
    logs.find(
      (entry) => entry.stage === "portrait.reference.read" && entry.event === "operation.started",
    ),
  ).toMatchObject({ style: "anime" });
});
