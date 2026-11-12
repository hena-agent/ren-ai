import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";
import type { RigJoint } from "./rig-test-model.ts";
import type { CanvasViewport } from "@rig-c/play";

export type RigFrame = readonly [number, number, number, number];

export function rigViewport(
  fitted: { left: number; top: number; scale: number },
  width: number,
  height: number,
): CanvasViewport {
  return {
    x: -fitted.left / fitted.scale,
    y: (fitted.top - height) / fitted.scale,
    width: width / fitted.scale,
    height: height / fitted.scale,
  };
}

/** One source-space envelope for the portrait and every diagnostic view. */
export function upperBodyFrame(
  width: number,
  height: number,
  joints: readonly RigJoint[],
  layers: readonly RigArtworkLayer[],
): RigFrame {
  const head = joints.find((joint) => joint.name === "head")!;
  const chest = joints.find((joint) => joint.name === "chest")!;
  const hip = joints.find((joint) => joint.name === "hip")!;
  const hx = head.x * width,
    hy = head.y * height;
  const headParts = layers.filter(
    (layer) =>
      layer.zIndex > 0 &&
      (layer.bone === "head" ||
        ["behind-body", "face", "front-body", "front-face"].includes(layer.plane ?? "") ||
        /hair|face|head/i.test(layer.name)),
  );
  const boxes: RigFrame[] = headParts.length
    ? headParts.map((layer) => [
        layer.bounds[0],
        layer.bounds[1],
        layer.bounds[2],
        Math.min(layer.bounds[3], chest.y * height),
      ])
    : [[hx - width * 0.1, 0, hx + width * 0.1, hy]];
  const points = boxes.flatMap(([left, top, right, bottom]) =>
    [-12, 0, 12].flatMap((degrees) => {
      const angle = (degrees * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle);
      return [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ].map(([x, y]) => ({
        x: hx + (x! - hx) * c + (y! - hy) * s,
        y: hy - (x! - hx) * s + (y! - hy) * c,
      }));
    }),
  );
  const torso = layers.filter(
    (layer) =>
      layer.zIndex > 0 &&
      (layer.bone === "chest" ||
        layer.bone?.startsWith("upperarm") ||
        /torso|upper.?arm/i.test(layer.name)),
  );
  const shoulders = joints
    .filter((joint) => joint.name.startsWith("upperarm"))
    .map((joint) => joint.x * width);
  const padding = width * 0.02;
  return [
    Math.min(
      ...points.map((point) => point.x),
      ...torso.map((layer) => layer.bounds[0]),
      ...shoulders,
    ) - padding,
    Math.min(...points.map((point) => point.y)) - padding,
    Math.max(
      ...points.map((point) => point.x),
      ...torso.map((layer) => layer.bounds[2]),
      ...shoulders,
    ) + padding,
    Math.max(hy + height * 0.08, (chest.y + (hip.y - chest.y) * 0.35) * height) + padding,
  ];
}

export function fitRigFrame(
  frame: RigFrame,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const [left, top, right, bottom] = frame;
  const pixelScale = Math.max(
    0.001,
    Math.min(
      Math.max(1, viewportWidth - 32) / (right - left),
      Math.max(1, viewportHeight - 32) / (bottom - top),
    ),
  );
  return {
    scale: (pixelScale * width) / 1000,
    left: (viewportWidth - (right - left) * pixelScale) / 2 - left * pixelScale,
    top: (viewportHeight - (bottom - top) * pixelScale) / 2 + (height - top) * pixelScale,
  };
}
