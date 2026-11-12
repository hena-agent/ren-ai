import { expect, test } from "vitest";
import { useBrowser } from "../test/browser.ts";
import { comparisonRoot } from "./rig-test-comparison.ts";

useBrowser();
test("original and flat comparisons use source coordinates rather than image raster dimensions or separate zoom factors", () => {
  const layer = {
    name: "Torso",
    zIndex: 1,
    imageUrl: "/native.png",
    width: 96,
    height: 192,
    bounds: [32, 16, 96, 144] as const,
  };
  const root = comparisonRoot(
    document,
    "flat",
    "/source.png",
    [{ layer, bone: "chest" }],
    256,
    512,
  );
  const img = root.querySelector("img")!;
  expect(img.getAttribute("src")).toBe("/native.png");
  expect(img.style.left).toBe("125px");
  expect(img.style.top).toBe("-1937.5px");
  expect(img.style.width).toBe("250px");
  expect(img.style.height).toBe("500px");
  const original = comparisonRoot(document, "original", "/source.png", [], 256, 512).querySelector(
    "img",
  )!;
  expect(original.style.width).toBe("1000px");
  expect(original.style.height).toBe("2000px");
  expect(original.style.top).toBe("-2000px");
  expect(original.draggable).toBe(false);
  expect(comparisonRoot(document, "flat", "/source.png", [], 256, 512).children).toHaveLength(0);
});
