import type { RigLayerBinding } from "./rig-test-model.ts";

/** Native image compositing, independent of the rig's mesh/atlas pipeline. */
export function comparisonRoot(
  document: Document,
  mode: "original" | "flat",
  source: string,
  bindings: readonly RigLayerBinding[],
  width: number,
  height: number,
) {
  const root = document.createElement("div");
  root.className = "rig-test-render-root";
  const items =
    mode === "original"
      ? [{ url: source, bounds: [0, 0, width, height] as const }]
      : bindings.map((binding) => ({ url: binding.layer.imageUrl, bounds: binding.layer.bounds }));
  const scale = 1000 / width;
  for (const item of items) {
    const image = document.createElement("img");
    image.src = item.url;
    image.alt = "";
    image.draggable = false;
    const [left, top, right, bottom] = item.bounds;
    Object.assign(image.style, {
      position: "absolute",
      left: `${left * scale}px`,
      top: `${(top - height) * scale}px`,
      width: `${(right - left) * scale}px`,
      height: `${(bottom - top) * scale}px`,
    });
    root.append(image);
  }
  return root;
}
