import { bindLayerInspection } from "./artwork-layer-inspection-controls.ts";
import { bindLayerLayout } from "./artwork-layer-layout-controls.ts";

export function bindArtworkLayerViewer(document: Document) {
  const page = document.querySelector<HTMLElement>("[data-artwork-layers]");
  if (!page) return;
  bindLayerInspection(page);
  bindLayerLayout(page);
  const inputs = [...page.querySelectorAll<HTMLInputElement>("[data-layer-toggle]")];
  const count = page.querySelector<HTMLElement>("[data-layer-count]")!;
  const original = page.querySelector<SVGImageElement>("[data-layer-original]")!;
  const compare = page.querySelector<HTMLInputElement>("[data-layer-compare]")!;
  const opacity = page.querySelector<HTMLInputElement>("[data-layer-opacity]")!;
  const update = () => {
    for (const input of inputs)
      page
        .querySelector<SVGImageElement>(`[data-layer-image="${input.dataset["layerToggle"]}"]`)!
        .setAttribute("display", input.checked ? "inline" : "none");
    count.textContent = `${inputs.filter((input) => input.checked).length} / ${inputs.length}개 표시`;
  };
  for (const input of inputs) input.addEventListener("change", update);
  for (const [selector, checked] of [
    ["[data-layers-all]", true],
    ["[data-layers-none]", false],
  ] as const)
    page.querySelector(selector)!.addEventListener("click", () => {
      for (const input of inputs) input.checked = checked;
      update();
    });
  compare.addEventListener("change", () => {
    original.setAttribute("display", compare.checked ? "inline" : "none");
  });
  opacity.addEventListener("input", () => {
    original.setAttribute("opacity", opacity.value);
  });
}
