import { expect, vi } from "vitest";
import type { createAdmin } from "../src/admin.ts";
import { request } from "./fixtures.ts";

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export function queuedRequest(
  path: string,
  fields: Record<string, string>,
  prompts?: readonly string[],
) {
  const original = request(path, fields);
  original.headers.set("X-Image-Queue", "1");
  if (!prompts) return original;
  const body = new URLSearchParams(fields);
  body.set("separateImagePrompts", "1");
  body.set("portraitInstructions", prompts[0] ?? "");
  for (const prompt of prompts.slice(1)) body.append("imagePrompts", prompt);
  return new Request(original, { method: "POST", body });
}

export function jobUrl(response: Response) {
  const location = response.headers.get("location");
  if (!location?.startsWith("/image-jobs/")) throw new Error("Expected queued image job");
  return location;
}

export async function finishedJob(admin: ReturnType<typeof createAdmin>, path: string) {
  let page = "";
  await vi.waitFor(async () => {
    const response = await admin(request(path));
    expect(response.status).toBe(200);
    page = await response.text();
    expect(page).toContain(`data-image-job="${path.split("/").at(-1)}" data-job-active="false"`);
  });
  return page;
}
