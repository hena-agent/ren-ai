import { expect, test } from "vitest";
import { composeFaceBindings } from "./rig-face.ts";
import { createRigTestModel, defaultRigJoints } from "./rig-test-model.ts";
import { faceGaze } from "./rig-face-gaze.ts";
import type { RigFacePart } from "@ren-ai/personas/rig-artwork";

test("a moving iris is preceded by a head-fixed aperture that ends at that iris, not its sibling or face", async () => {
  const aperture = [
    [570, 198],
    [590, 193],
    [610, 205],
    [590, 211],
  ] as const;
  const bindings = composeFaceBindings(
    [],
    [
      {
        role: "pupil-left",
        state: "neutral",
        imageUrl: "/images/test.png",
        bounds: [579, 190, 603, 214],
        aperture,
        gaze: { x: 4, y: 2 },
      },
    ],
    1248,
    1824,
  );
  const model = await createRigTestModel(1248, 1824, defaultRigJoints(), bindings);
  expect(model.slots.map((slot) => slot.name)).toEqual([
    "face-pupil-left-neutral-clip",
    "face-pupil-left-neutral",
  ]);
  const clip =
    model.skins[0]!.attachments["face-pupil-left-neutral-clip"]!["face-pupil-left-neutral-clip"]!;
  expect(clip).toMatchObject({ kind: "clipping", end: "face-pupil-left-neutral" });
  expect(
    clip.vertices.bindings.every((vertex) => vertex.every((binding) => binding.bone === "head")),
  ).toBe(true);
  expect(model.pages).toHaveLength(1);
});

test("gaze uses each selected eye's source-pixel limits and refuses unmasked cutout pupils", () => {
  const aperture = [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ] as const;
  const parts: RigFacePart[] = (["pupil-left", "pupil-right"] as const).map((role, index) => ({
    role,
    state: "neutral",
    imageUrl: "/images/test.png",
    aperture,
    gaze: { x: 4 + index, y: 2 + index },
  }));
  const gaze = faceGaze(parts, "neutral", 1, -1, 2000);
  expect(gaze).toEqual({
    ready: true,
    offsets: [
      { bone: "pupil-left", x: 2, y: 1 },
      { bone: "pupil-right", x: 2.5, y: 1.5 },
    ],
  });
  expect(faceGaze(parts, "neutral", 5, -5, 2000)).toEqual(gaze);
  expect(
    faceGaze(
      parts.map((part) => ({ role: part.role, state: part.state, imageUrl: part.imageUrl })),
      "neutral",
      1,
      1,
      2000,
    ),
  ).toEqual({
    ready: false,
    offsets: [
      { bone: "pupil-left", x: 0, y: 0 },
      { bone: "pupil-right", x: 0, y: 0 },
    ],
  });
  expect(faceGaze([], "neutral", 0, 0, 1000)).toEqual({ ready: false, offsets: [] });
  expect(
    faceGaze(
      parts.map((part) => ({
        role: part.role,
        state: part.state,
        imageUrl: part.imageUrl,
        aperture,
      })),
      "neutral",
      1,
      1,
      2000,
    ).ready,
  ).toBe(false);
  const surprised: RigFacePart[] = parts.map((part) => ({
    ...part,
    state: "surprised",
    gaze: { x: 8, y: 3 },
  }));
  expect(faceGaze([...parts, ...surprised], "surprised", 1, -1, 2000).offsets).toEqual([
    { bone: "pupil-left", x: 4, y: 1.5 },
    { bone: "pupil-right", x: 4, y: 1.5 },
  ]);
});
