import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";
import { weightedLayerGeometry, type RigPoint } from "./rig-test-mesh.ts";

export function hairMotionBone(layer: RigArtworkLayer) {
  if (!/hair/i.test(layer.name)) return undefined;
  if (layer.plane === "front-body") return "hair-front";
  if (layer.plane === "behind-body") return "hair-back";
  return undefined;
}

/** Scalp stays rigid with the face; only the hanging length receives follow-through. */
export function hairGeometry(
  layer: RigArtworkLayer,
  positions: ReadonlyMap<string, RigPoint>,
  width: number,
  height: number,
) {
  const tail = hairMotionBone(layer);
  if (!tail) return undefined;
  const head = positions.get("head")!,
    rigHeight = (height * 1000) / width;
  return weightedLayerGeometry(
    layer,
    width,
    height,
    (point) => {
      const t = Math.max(
        0,
        Math.min(1, (head.y + rigHeight * 0.015 - point.y) / (rigHeight * 0.08)),
      );
      const weight = t * t * (3 - 2 * t);
      return (
        [
          ["head", 1 - weight],
          [tail, weight],
        ] as const
      ).flatMap(([bone, amount]) =>
        amount === 0 ? [] : [{ bone, x: point.x - head.x, y: point.y - head.y, weight: amount }],
      );
    },
    128,
  );
}
