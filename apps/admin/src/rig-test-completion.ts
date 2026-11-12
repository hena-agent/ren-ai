import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";
import type { RigJoint } from "./rig-test-model.ts";
import { weightedLayerGeometry } from "./rig-test-mesh.ts";

type Point = { x: number; y: number };
function distance(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)),
  );
  return (point.x - start.x - t * dx) ** 2 + (point.y - start.y - t * dy) ** 2;
}

/** The sparse completion PNG spans many body parts, so its vertices follow local bones. */
export function completionGeometry(
  layer: RigArtworkLayer,
  joints: readonly RigJoint[],
  positions: ReadonlyMap<string, Point>,
  width: number,
  height: number,
) {
  const scale = 1000 / width;
  const segments = joints.map((joint) => {
    const start = positions.get(joint.name)!;
    const parent = positions.get(joint.parent)!;
    const end = positions.get(joints.find((child) => child.parent === joint.name)?.name ?? "") ?? {
      x: start.x + (start.x - parent.x) * 0.5,
      y: start.y + (start.y - parent.y) * 0.5,
    };
    return { name: joint.name, start, end };
  });
  return weightedLayerGeometry(layer, width, height, (point) => {
    const sourceY = height - point.y / scale;
    let bone = "root";
    if (sourceY < height * 0.94) {
      let best = Infinity;
      for (const segment of segments) {
        const d = distance(point, segment.start, segment.end);
        if (d < best) {
          best = d;
          bone = segment.name;
        }
      }
    }
    const origin = positions.get(bone)!;
    return [{ bone, x: point.x - origin.x, y: point.y - origin.y, weight: 1 }];
  });
}
