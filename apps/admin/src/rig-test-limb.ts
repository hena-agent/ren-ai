import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";
import { weightedLayerGeometry, type RigPoint } from "./rig-test-mesh.ts";

function blend(point: RigPoint, start: RigPoint, end: RigPoint, radius: number) {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const projected = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length;
  const t = Math.max(0, Math.min(1, 0.5 + projected / (2 * radius)));
  return t * t * (3 - 2 * t);
}

function bindings(
  point: RigPoint,
  bones: readonly string[],
  weights: readonly number[],
  positions: ReadonlyMap<string, RigPoint>,
) {
  return weights.flatMap((weight, index) => {
    if (weight === 0) return [];
    const bone = bones[index]!,
      origin = positions.get(bone)!;
    return [{ bone, x: point.x - origin.x, y: point.y - origin.y, weight }];
  });
}

/** Adjacent parts share weights around the joint, rather than exposing a rigid cut. */
export function limbGeometry(
  layer: RigArtworkLayer,
  bone: string,
  positions: ReadonlyMap<string, RigPoint>,
  width: number,
  height: number,
) {
  if (bone === "chest" || (bone === "head" && /face|neck/i.test(layer.name))) {
    const chest = positions.get("chest")!,
      head = positions.get("head")!;
    const distance = Math.max(1, Math.hypot(head.x - chest.x, head.y - chest.y));
    const radius = Math.max(1, distance * 0.12);
    // Leave the jaw and the mesh cell beneath it rigid; bend lower in the neck.
    const center = { x: head.x + (chest.x - head.x) * 0.08, y: head.y + (chest.y - head.y) * 0.08 };
    const above = { x: center.x + head.x - chest.x, y: center.y + head.y - chest.y };
    return weightedLayerGeometry(layer, width, height, (point) => {
      const vertical = blend(point, center, above, radius);
      const neck = Math.max(
        0,
        Math.min(1, (distance * 0.5 - Math.abs(point.x - head.x)) / (distance * 0.18)),
      );
      const amount = vertical * (neck + (1 - neck) * vertical ** 4);
      return bindings(point, ["chest", "head"], [1 - amount, amount], positions);
    });
  }
  if (!/^(upperarm|forearm|hand|thigh|shin|foot)_[lr]$/.test(bone)) return undefined;
  const side = bone.slice(-1);
  const names = /^(upperarm|forearm|hand)/.test(bone)
    ? ["upperarm", "forearm", "hand"]
    : ["thigh", "shin", "foot"];
  const bones = names.map((name) => name + "_" + side);
  const middle = positions.get(bones[1]!)!,
    end = positions.get(bones[2]!)!;
  const distance = Math.max(1, Math.hypot(end.x - middle.x, end.y - middle.y));
  const tip = { x: end.x + (end.x - middle.x), y: end.y + (end.y - middle.y) };
  return weightedLayerGeometry(layer, width, height, (point) => {
    const distal = blend(point, middle, end, distance * 0.25);
    const terminal = blend(point, end, tip, distance * 0.12);
    return bindings(
      point,
      bones,
      [1 - distal, distal * (1 - terminal), distal * terminal],
      positions,
    );
  });
}
