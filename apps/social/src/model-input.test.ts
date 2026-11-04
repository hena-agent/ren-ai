import { expect, test, vi } from "vitest";
import { socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
import type { SocialImage, SocialImageData } from "@ren-ai/onboarding/social-images";
import { imageFiles, socialPrompt } from "./model-input.ts";

const task = socialTask();
const image: SocialImage = {
  id: "draft",
  accountId: task.account.id,
  personaId: task.account.personaId,
  generation: task.run.generation,
  kind: "self",
  style: "photo",
  state: "ready",
  probability: 6000,
  roll: 5000,
  kindRoll: 4000,
  createdAt: 1,
};
test("public visual planning discloses AI identity, records contextual dice choices, and requires image inspection", async () => {
  const selected = {
    ...task,
    account: {
      ...task.account,
      platform: "threads" as const,
      images: { enabled: true, style: "photo" as const, credits: 3 },
    },
    images: [image],
  };
  const preview = vi.fn<(run: string, id: string) => Promise<SocialImageData>>(async () => ({
    id: "draft",
    data: "test-image",
    mime: "image/jpeg",
  }));
  const files = await imageFiles(selected, task.run, preview);
  expect(files).toMatchObject([
    {
      uri: "data:image/jpeg;base64,test-image",
      name: "draft.jpg",
    },
  ]);
  expect(files[0]?.description).toContain("inspect the image");
  expect(preview).toHaveBeenCalledWith(task.run.id, "draft");
  const prompt = socialPrompt(selected, task.run, "actual public reactions", "{}");
  expect(prompt).toContain("openly represent a fictional RenAI AI persona");
  expect(prompt).toContain("75:25");
  expect(prompt).toContain("not a daily image target");
  expect(prompt).toContain("Approval does not require posting");
  expect(prompt).toContain("actual public reactions");
  expect(prompt).not.toContain("test-image");
  expect(prompt).not.toContain('"roll"');
  expect(prompt).not.toContain('"kindRoll"');
  expect(prompt).not.toContain('"diagnostic"');
});
test("private conversations never receive public image drafts or trigger their preview", async () => {
  const privateRun = { ...task.run, contact: "reader" };
  const preview = vi.fn<(run: string, id: string) => Promise<SocialImageData>>();
  expect(await imageFiles({ ...task, images: [image] }, privateRun, preview)).toEqual([]);
  expect(preview).not.toHaveBeenCalled();
  expect(
    socialPrompt({ ...task, images: [image] }, privateRun, "private observation", "{}"),
  ).not.toContain('"id":"draft"');
  expect(await imageFiles(task, task.run, preview)).toEqual([]);
  expect(socialPrompt(task, task.run, "observation", "{}")).toContain(
    "Image generation is unavailable",
  );
  expect(
    await imageFiles({ ...task, images: [{ ...image, state: "queued" }] }, task.run, preview),
  ).toEqual([]);
  await expect(imageFiles({ ...task, images: [image] }, task.run, undefined)).rejects.toThrow(
    "preview is unavailable",
  );
  await expect(
    imageFiles({ ...task, images: [image] }, task.run, async () => ({
      id: "wrong",
      data: "",
      mime: "image/jpeg",
    })),
  ).rejects.toThrow("identity changed");
});
