import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { useBrowser } from "../test/browser.ts";
import { deferred } from "../test/queue.ts";
import { inspectArtworkLayers } from "./artwork-layer-inspection.ts";
import { bindLayerInspection } from "./artwork-layer-inspection-controls.ts";
import { artworkLayerQuality } from "./artwork-layer-quality.ts";

useBrowser();
function mounted() {
  document.body.innerHTML = `<main><button data-layer-inspect>검사</button><select data-layer-inspection-mode><option value="none">없음</option><option value="missing">누락</option><option value="difference">색차</option></select><output data-layer-quality></output><svg class="layer-canvas" width="1" height="1"><image data-layer-image="0" href="/base.png" x="0" y="0" width="1" height="1"></image><image data-layer-image="1" href="/arm.png" x="0" y="0" width="1" height="1"></image><image data-layer-original href="/original.png"></image></svg><canvas data-layer-inspection-overlay hidden></canvas></main>`;
  return {
    page: document.querySelector("main")!,
    button: document.querySelector<HTMLButtonElement>("button")!,
    mode: document.querySelector<HTMLSelectElement>("select")!,
    canvas: document.querySelector("canvas")!,
    status: document.querySelector("output")!,
  };
}
function context(pixels = new Uint8ClampedArray([0, 0, 0, 255])) {
  const draw = vi.fn<CanvasRenderingContext2D["drawImage"]>();
  const put = vi.fn<CanvasRenderingContext2D["putImageData"]>();
  const canvas = fromPartial<CanvasRenderingContext2D>({
    drawImage: draw,
    fillRect: vi.fn<CanvasRenderingContext2D["fillRect"]>(),
    getImageData: () => fromPartial<ImageData>({ data: pixels }),
    createImageData: () => fromPartial<ImageData>({ data: new Uint8ClampedArray(4) }),
    putImageData: put,
  });
  return { canvas, draw, put };
}
const result = () => artworkLayerQuality([0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 0], 1, 1);

test("inspection draws saved pixel geometry, includes base color but excludes base alpha from coverage", async () => {
  const ui = mounted();
  const source = context(),
    composite = context(new Uint8ClampedArray([255, 255, 255, 255])),
    foreground = context(new Uint8ClampedArray(4));
  vi.spyOn(document.defaultView!.HTMLCanvasElement.prototype, "getContext")
    .mockReturnValueOnce(source.canvas)
    .mockReturnValueOnce(composite.canvas)
    .mockReturnValueOnce(foreground.canvas);
  const image = document.createElement("img");
  const load = vi.fn<(url: string) => Promise<HTMLImageElement>>().mockResolvedValue(image);
  const measured = await inspectArtworkLayers(ui.page, load);
  expect(measured.missingPercent).toBe(100);
  expect(measured.differentPercent).toBe(100);
  expect(load.mock.calls.map(([url]) => url)).toEqual(["/original.png", "/base.png", "/arm.png"]);
  expect(foreground.draw).toHaveBeenCalledOnce();
  expect(composite.draw).toHaveBeenCalledTimes(2);
  expect(foreground.draw).toHaveBeenCalledWith(image, 0, 0, 1, 1);
});

test("native image inspection requests CORS-safe images and refuses unavailable canvas", async () => {
  const ui = mounted();
  vi.spyOn(document.defaultView!.HTMLImageElement.prototype, "decode").mockResolvedValue(undefined);
  const ctx = context();
  const canvas = vi
    .spyOn(document.defaultView!.HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx.canvas);
  await inspectArtworkLayers(ui.page);
  expect(ctx.draw.mock.calls[0]![0]).toHaveProperty("crossOrigin", "anonymous");
  canvas.mockReturnValueOnce(null);
  await expect(inspectArtworkLayers(ui.page)).rejects.toThrow("unavailable");
});

test("overlay controls show missing and different pixels, and invalidate measurements after placement edits", async () => {
  const ui = mounted();
  const ctx = context();
  vi.spyOn(ui.canvas, "getContext").mockReturnValue(ctx.canvas);
  const inspect = vi.fn<typeof inspectArtworkLayers>().mockResolvedValue(result());
  bindLayerInspection(ui.page, inspect);
  ui.mode.dispatchEvent(new Event("change"));
  ui.button.click();
  expect(ui.button.disabled).toBe(true);
  await vi.waitFor(() => expect(ui.status.textContent).toContain("미덮임 100.0%"));
  expect(ui.canvas.hidden).toBe(false);
  expect(ctx.put.mock.calls[0]![0].data).toEqual(result().missingMask);
  ui.mode.value = "difference";
  ui.mode.dispatchEvent(new Event("change"));
  expect(ctx.put.mock.calls[1]![0].data).toEqual(result().differenceMask);
  ui.mode.value = "none";
  ui.mode.dispatchEvent(new Event("change"));
  expect(ui.canvas.hidden).toBe(true);
  ui.page.dispatchEvent(new Event("layer-layout-change"));
  expect(ui.status.textContent).toContain("다시 실행");
});

test.each(["error", "non-error", "canvas"])(
  "inspection %s failures leave the original layers intact with diagnostics",
  async (failure) => {
    const ui = mounted();
    vi.spyOn(ui.canvas, "getContext").mockReturnValue(null);
    const report = vi.fn<(error: Error) => void>();
    window.reportError = report;
    const inspect = vi.fn<typeof inspectArtworkLayers>();
    if (failure === "canvas") inspect.mockResolvedValue(result());
    else
      inspect.mockRejectedValue(
        failure === "error" ? new Error("private image URL") : "private text",
      );
    bindLayerInspection(ui.page, inspect);
    ui.button.click();
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(ui.status.textContent).toContain("읽지 못해");
    expect(JSON.stringify(report.mock.calls[0]![0].cause)).not.toMatch(/private/);
    expect(ui.page.querySelectorAll("[data-layer-image]")).toHaveLength(2);
  },
);

test.each([true, false])(
  "obsolete measurement success=%s cannot overwrite a placement change",
  async (success) => {
    const ui = mounted();
    const pending = deferred<ReturnType<typeof result>>();
    const inspect = vi.fn<typeof inspectArtworkLayers>().mockImplementation(async () => {
      const value = await pending.promise;
      if (!success) throw new Error("old failure");
      return value;
    });
    bindLayerInspection(ui.page, inspect);
    ui.button.click();
    ui.page.dispatchEvent(new Event("layer-layout-change"));
    pending.resolve(result());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.status.textContent).toContain("다시 실행");
    expect(ui.canvas.hidden).toBe(true);
    expect(ui.button.disabled).toBe(false);
  },
);
