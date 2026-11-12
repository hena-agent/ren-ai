import { expect, test } from "vitest";
import { hairMotionBone, hairGeometry } from "./rig-test-hair.ts";
import { createRigTestModel, defaultRigJoints } from "./rig-test-model.ts";

test("hanging hair has a rigid scalp, continuous tail weights and an authored follow-through bone", async () => {
  const layer = {
    name: "Front Hair",
    plane: "front-body" as const,
    zIndex: 16,
    imageUrl: "/hair.png",
    width: 240,
    height: 460,
    bounds: [500, 30, 740, 490] as const,
  };
  expect(hairMotionBone({ ...layer, plane: "behind-body" })).toBe("hair-back");
  expect(hairMotionBone({ ...layer, name: "Ribbon" })).toBeUndefined();
  expect(hairGeometry({ ...layer, plane: "front-face" }, new Map(), 1248, 1824)).toBeUndefined();
  const model = await createRigTestModel(1248, 1824, defaultRigJoints(), [
    { layer, bone: "head" },
    { layer: { ...layer, name: "Back Hair", plane: "behind-body", zIndex: 1 }, bone: "head" },
  ]);
  expect(model.bones.find((bone) => bone.name === "hair-back")).toMatchObject({ parent: "head" });
  expect(model.bones.find((bone) => bone.name === "hair-front")).toMatchObject({
    parent: "head",
    x: 0,
    y: 0,
  });
  const mesh = model.skins[0]!.attachments["layer-16"]!["layer-16"]!;
  if (mesh.kind !== "mesh") throw new Error("Expected hair mesh");
  expect(mesh.vertices.bindings[0]).toHaveLength(1);
  expect(mesh.vertices.bindings[0]![0]).toMatchObject({ bone: "head", weight: 1 });
  expect(mesh.vertices.bindings[0]![0]!.x).toBeCloseTo((500 * 1000) / 1248 - 500);
  expect(mesh.vertices.bindings[0]![0]!.y).toBeCloseTo(
    ((1824 - 30) * 1000) / 1248 - ((1 - 0.19) * 1824 * 1000) / 1248,
  );
  expect(mesh.vertices.bindings.some((vertex) => vertex.length === 2)).toBe(true);
  expect(mesh.vertices.bindings.at(-1)![0]!.bone).toBe("hair-front");
  for (const vertex of mesh.vertices.bindings)
    expect(vertex.reduce((sum, binding) => sum + binding.weight, 0)).toBeCloseTo(1);
  expect(
    model.animations[1]!.bones.find((bone) => bone.name === "chest")!.timelines.some(
      (timeline) => timeline.name === "scaley",
    ),
  ).toBe(true);
  const keys = model.animations[1]!.bones.find((bone) => bone.name === "head")!.timelines[0]!.keys;
  for (let i = 1; i < keys.length - 1; i++) {
    const previous = keys[i - 1]!,
      current = keys[i]!;
    if (!previous.curve || !current.curve)
      throw new Error("Expected a continuously eased idle curve");
    const incoming = (current.value - previous.curve[3]!) / (current.time - previous.curve[2]!);
    const outgoing = (current.curve[1]! - current.value) / (current.curve[0]! - current.time);
    expect(incoming).toBeCloseTo(outgoing, 6);
  }
});
