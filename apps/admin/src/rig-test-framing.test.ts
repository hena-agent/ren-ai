import { expect, test } from "vitest";
import { defaultRigJoints } from "./rig-test-model.ts";
import { upperBodyFrame, fitRigFrame, rigViewport } from "./rig-test-framing.ts";
import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";

test("portrait framing contains the complete rotating head with a constant camera at mobile and desktop sizes", () => {
  const width = 1248,
    height = 1824,
    joints = defaultRigJoints();
  const layers: RigArtworkLayer[] = [
    {
      name: "Front Hair",
      zIndex: 1,
      imageUrl: "/hair.png",
      width: 219,
      height: 434,
      bounds: [524, 39, 743, 473],
    },
    {
      name: "Core",
      bone: "chest",
      zIndex: 2,
      imageUrl: "/torso.png",
      width: 400,
      height: 800,
      bounds: [440, 300, 830, 1100],
    },
    {
      name: "Upper Arm",
      zIndex: 3,
      imageUrl: "/arm.png",
      width: 80,
      height: 300,
      bounds: [410, 350, 490, 650],
    },
  ];
  const frame = upperBodyFrame(width, height, joints, layers);
  expect(rigViewport({ left: -100, top: 1400, scale: 2 }, 600, 800)).toEqual({
    x: 50,
    y: 300,
    width: 300,
    height: 400,
  });
  const authored = layers.map((layer, index) => ({
    ...layer,
    name: "Authored part",
    bone: ["head", "chest", "upperarm_l"][index]!,
  }));
  expect(upperBodyFrame(width, height, joints, authored)).toEqual(frame);
  for (const [vw, vh] of [
    [288, 560],
    [358, 620],
    [720, 760],
    [900, 420],
  ]) {
    const fit = fitRigFrame(frame, width, height, vw!, vh!),
      scale = (fit.scale * 1000) / width;
    for (const x of [frame[0], frame[2]])
      expect(fit.left + x * scale).toBeGreaterThanOrEqual(15.99);
    for (const y of [frame[1], frame[3]])
      expect(fit.top - (height - y) * scale).toBeGreaterThanOrEqual(15.99);
    expect(fit.top - (height - frame[3]) * scale).toBeLessThanOrEqual(vh! - 15.99);
    for (const degrees of [-12, 0, 12])
      for (const x of [524, 743])
        for (const y of [39, 473]) {
          const angle = (degrees * Math.PI) / 180,
            hx = width * 0.5,
            hy = height * 0.19;
          const px = hx + (x - hx) * Math.cos(angle) + (y - hy) * Math.sin(angle);
          const py = hy - (x - hx) * Math.sin(angle) + (y - hy) * Math.cos(angle);
          expect(fit.left + px * scale).toBeGreaterThanOrEqual(15.99);
          expect(fit.left + px * scale).toBeLessThanOrEqual(vw! - 15.99);
          expect(fit.top - (height - py) * scale).toBeGreaterThanOrEqual(15.99);
          expect(fit.top - (height - py) * scale).toBeLessThanOrEqual(vh! - 15.99);
        }
  }
  expect(frame[1]).toBeLessThan(0);
  expect(frame[3]).toBeLessThan(height * 0.5);
  expect(upperBodyFrame(width, height, joints, []).every(Number.isFinite)).toBe(true);
});
