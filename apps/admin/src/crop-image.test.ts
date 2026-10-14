import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { cropBlob, cropRectangle } from "./crop-image.ts";

test("4:5 crops stay inside portrait and landscape sources at every zoom and edge", () => {
  for (const [width, height] of [
    [400, 1200],
    [1600, 900],
    [1024, 1280],
  ])
    for (const zoom of [1, 2, 3])
      for (const x of [0, 50, 100])
        for (const y of [0, 50, 100]) {
          const rect = cropRectangle(width!, height!, zoom, x, y);
          expect(rect.width / rect.height).toBeCloseTo(4 / 5);
          expect(rect.x).toBeGreaterThanOrEqual(0);
          expect(rect.y).toBeGreaterThanOrEqual(0);
          expect(rect.x + rect.width).toBeLessThanOrEqual(width!);
          expect(rect.y + rect.height).toBeLessThanOrEqual(height!);
        }
});

test("canvas encoding returns JPEG bytes and reports unavailable encoding", async () => {
  const blob = new Blob(["jpeg"], { type: "image/jpeg" });
  const encoder = vi
    .fn<(callback: BlobCallback) => void>()
    .mockImplementation((callback) => callback(blob));
  const canvas = fromPartial<HTMLCanvasElement>({ toBlob: encoder });
  expect(await cropBlob(canvas)).toBe(blob);
  expect(encoder).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
  encoder.mockImplementation((callback) => callback(null));
  await expect(cropBlob(canvas)).rejects.toThrow("사진을 변환");
});
