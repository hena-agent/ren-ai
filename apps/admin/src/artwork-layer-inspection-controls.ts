import { inspectArtworkLayers } from "./artwork-layer-inspection.ts";
import type { ArtworkLayerQuality } from "./artwork-layer-quality.ts";

export function bindLayerInspection(page: HTMLElement, inspect = inspectArtworkLayers) {
  const document = page.ownerDocument;
  const button = page.querySelector<HTMLButtonElement>("[data-layer-inspect]")!;
  const mode = page.querySelector<HTMLSelectElement>("[data-layer-inspection-mode]")!;
  const status = page.querySelector<HTMLElement>("[data-layer-quality]")!;
  const canvas = page.querySelector<HTMLCanvasElement>("[data-layer-inspection-overlay]")!;
  let result: ArtworkLayerQuality | undefined,
    revision = 0;
  const draw = () => {
    canvas.hidden = !result || mode.value === "none";
    if (!result || canvas.hidden) return;
    const stage = page.querySelector<SVGSVGElement>(".layer-canvas")!;
    canvas.width = Number(stage.getAttribute("width"));
    canvas.height = Number(stage.getAttribute("height"));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas comparison overlay unavailable");
    const pixels = context.createImageData(canvas.width, canvas.height);
    pixels.data.set(mode.value === "missing" ? result.missingMask : result.differenceMask);
    context.putImageData(pixels, 0, 0);
  };
  mode.addEventListener("change", draw);
  button.addEventListener("click", () => {
    const observed = ++revision;
    button.disabled = true;
    status.textContent = "전체 레이어와 원본을 비교하고 있습니다…";
    void inspect(page)
      .then((value) => {
        if (observed !== revision) return undefined;
        result = value;
        status.textContent = `미덮임 ${value.missingPercent.toFixed(1)}% · 색차 영역 ${value.differentPercent.toFixed(1)}% · 평균 색차 ${value.meanColorError.toFixed(1)}/255 · 전체 재합성 기준, 수동 검수 필요`;
        mode.value = "missing";
        draw();
        return undefined;
      })
      .catch((cause) => {
        if (observed !== revision) return;
        status.textContent = "이미지를 읽지 못해 원본 비교를 실행할 수 없습니다.";
        document.defaultView!.reportError(
          new Error("Layer inspection failed", {
            cause: {
              stage: "rig.layers.inspect",
              code: "inspection_failed",
              causeName: cause instanceof Error ? cause.name : typeof cause,
            },
          }),
        );
      })
      .finally(() => {
        if (observed === revision) button.disabled = false;
      });
  });
  page.addEventListener("layer-layout-change", () => {
    revision++;
    result = undefined;
    canvas.hidden = true;
    button.disabled = false;
    status.textContent = "배치가 변경되었습니다. 원본 비교를 다시 실행하세요.";
  });
}
