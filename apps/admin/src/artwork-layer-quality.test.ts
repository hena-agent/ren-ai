import { expect, test } from "vitest";
import { artworkLayerQuality } from "./artwork-layer-quality.ts";

test("missing visible source pixels and color drift are separate measurements, excluding white background", () => {
  const original = [0, 0, 0, 255, 100, 90, 80, 255, 255, 255, 255, 255];
  const composite = [0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255];
  const alpha = [0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0];
  const result = artworkLayerQuality(original, composite, alpha, 3, 1);
  expect(result.pixels).toBe(2);
  expect(result.missingPercent).toBe(50);
  expect(result.differentPercent).toBe(50);
  expect(result.missingMask.slice(4, 8)).toEqual(new Uint8ClampedArray([255, 30, 90, 210]));
  expect(result.differenceMask.slice(4, 8)).toEqual(new Uint8ClampedArray([30, 140, 255, 180]));
  expect(result.meanColorError).toBe(82.5);
});

test("transparent and blank inputs do not invent a quality verdict", () => {
  expect(artworkLayerQuality([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], 1, 1).pixels).toBe(0);
  const white = [255, 255, 255, 255];
  const result = artworkLayerQuality(white, white, white, 1, 1);
  expect(result.missingPercent).toBe(0);
  expect(result.differentPercent).toBe(0);
  expect(result.meanColorError).toBe(0);
  expect(() => artworkLayerQuality([], [], [], 1, 1)).toThrow("dimensions");
  expect(() => artworkLayerQuality([], [], [], 0, 1)).toThrow("dimensions");
  expect(() => artworkLayerQuality([], [], [], 1, 0)).toThrow("dimensions");
  expect(() => artworkLayerQuality(white, [], white, 1, 1)).toThrow("dimensions");
  expect(() => artworkLayerQuality(white, white, [], 1, 1)).toThrow("dimensions");
});
