import { expect, test } from "vitest";
import {
  createRigTestModel,
  defaultRigJoints,
  type RigLayerBinding,
  type RigJoint,
} from "./rig-test-model.ts";
import { suggestedRigBone } from "./rig-test-binding.ts";

const bindings: RigLayerBinding[] = [
  {
    layer: {
      name: "Base",
      zIndex: 0,
      imageUrl: "/base.png",
      width: 1000,
      height: 1500,
      bounds: [0, 0, 1000, 1500],
    },
    bone: "root",
  },
  {
    layer: {
      name: "Right Forearm",
      zIndex: 1,
      imageUrl: "/forearm.png",
      width: 100,
      height: 200,
      bounds: [250, 500, 350, 700],
    },
    bone: "forearm_l",
  },
  {
    layer: {
      name: "Right Hand",
      zIndex: 2,
      imageUrl: "/hand.png",
      width: 80,
      height: 100,
      bounds: [200, 680, 280, 780],
    },
    bone: "hand_l",
  },
];

function restPoint(
  vertex: readonly { bone: string; x: number; y: number; weight: number }[],
  joints: readonly RigJoint[],
) {
  return vertex.reduce(
    (point, binding) => {
      const joint = joints.find((candidate) => candidate.name === binding.bone)!;
      return {
        x: point.x + (binding.x + joint.x * 1000) * binding.weight,
        y: point.y + (binding.y + (1 - joint.y) * 1500) * binding.weight,
      };
    },
    { x: 0, y: 0 },
  );
}

test("separated PNGs have independent skinned meshes and textures, with hand inheriting its forearm", async () => {
  const model = await createRigTestModel(1000, 1500, defaultRigJoints(), bindings);
  expect(model.spine.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(
    suggestedRigBone({ ...bindings[1]!.layer, name: "Unclassified", bone: "head" }, 1000),
  ).toBe("head");
  expect(model.pages.map((page) => page.name)).toEqual(["layer-0", "layer-1", "layer-2"]);
  expect(model.bones.find((bone) => bone.name === "hand_l")).toMatchObject({ parent: "forearm_l" });
  expect(model.animations[3]!.bones.map((bone) => bone.name)).toEqual(["forearm_l", "forearm_r"]);
  const mesh = model.skins[0]!.attachments["layer-1"]!["layer-1"]!;
  if (mesh.kind !== "mesh") throw new Error("Expected a skinned mesh");
  expect(mesh.vertices.bindings.length).toBeGreaterThan(4);
  for (const vertex of mesh.vertices.bindings)
    expect(vertex.reduce((sum, binding) => sum + binding.weight, 0)).toBeCloseTo(1);
  expect(restPoint(mesh.vertices.bindings[0]!, defaultRigJoints())).toMatchObject({
    x: 250,
    y: 1000,
  });
  expect(mesh.triangles.length).toBeGreaterThan(6);
});

test("repositioning a pivot rebinds the quad without moving its rest position", async () => {
  const joints = defaultRigJoints();
  joints[4]!.x = 0.4;
  const model = await createRigTestModel(1000, 1500, joints, bindings);
  const rest = restPoint(
    model.skins[0]!.attachments["layer-1"]!["layer-1"]!.vertices.bindings[0]!,
    joints,
  );
  expect(rest.x).toBeCloseTo(250);
  expect(rest.y).toBeCloseTo(1000);
  await expect(
    createRigTestModel(1000, 1500, joints, [{ ...bindings[1]!, bone: "" }]),
  ).rejects.toThrow("관절 연결");
});

test("adjacent arm pieces share the exact skinning field at overlaps instead of opening rigid cuts", async () => {
  const layer = { ...bindings[1]!.layer, bounds: [300, 450, 400, 650] as const };
  const model = await createRigTestModel(1000, 1500, defaultRigJoints(), [
    { layer: { ...layer, zIndex: 1 }, bone: "upperarm_l" },
    { layer: { ...layer, zIndex: 2 }, bone: "forearm_l" },
  ]);
  const parts = model.skins[0]!.attachments;
  expect(parts["layer-1"]!["layer-1"]!.vertices).toEqual(parts["layer-2"]!["layer-2"]!.vertices);
  expect(parts["layer-1"]!["layer-1"]!.vertices.bindings.some((vertex) => vertex.length > 1)).toBe(
    true,
  );
});

test("face and torso share a neck bend while front and back hair remain rigidly attached to the head", async () => {
  const layer = { ...bindings[1]!.layer, bounds: [450, 220, 560, 350] as const };
  const model = await createRigTestModel(1000, 1500, defaultRigJoints(), [
    { layer: { ...layer, zIndex: 1, name: "Face and Neck" }, bone: "head" },
    { layer: { ...layer, zIndex: 2, name: "Torso" }, bone: "chest" },
    { layer: { ...layer, zIndex: 3, name: "Front Hair" }, bone: "head" },
    { layer: { ...layer, zIndex: 4, name: "Back Hair" }, bone: "head" },
  ]);
  const parts = model.skins[0]!.attachments;
  expect(parts["layer-1"]!["layer-1"]!.vertices).toEqual(parts["layer-2"]!["layer-2"]!.vertices);
  expect(
    parts["layer-1"]!["layer-1"]!.vertices.bindings.some((vertex) => vertex.length === 2),
  ).toBe(true);
  const face = parts["layer-1"]!["layer-1"]!;
  if (face.kind !== "mesh") throw new Error("Expected a face mesh");
  const rigidFace = face.vertices.bindings.filter(
    (_vertex, index) => 220 + face.uvs[index * 2 + 1]! * 130 <= 1500 * 0.18,
  );
  expect(rigidFace.length).toBeGreaterThan(0);
  for (const vertex of rigidFace) {
    expect(vertex).toHaveLength(1);
    expect(vertex[0]).toMatchObject({ bone: "head", weight: 1 });
  }
  for (const key of ["layer-3", "layer-4"]) {
    const vertices = parts[key]![key]!.vertices.bindings;
    expect(vertices).toHaveLength(4);
    expect(
      vertices.every(
        (vertex) => vertex.length === 1 && vertex[0]!.bone === "head" && vertex[0]!.weight === 1,
      ),
    ).toBe(true);
  }
});

test("saved source-specific pivots initialize each pose and all limb families have normalized weights", async () => {
  const joints = defaultRigJoints([
    { name: "forearm_l", x: 0.364, y: 0.356 },
    { name: "hand_l", x: 0.364, y: 0.356 },
  ]);
  expect(joints.find((joint) => joint.name === "forearm_l")).toMatchObject({ x: 0.364, y: 0.356 });
  const model = await createRigTestModel(
    1000,
    1500,
    joints,
    ["hand_l", "forearm_r", "foot_l", "shin_r"].map((bone, index) => ({
      layer: { ...bindings[1]!.layer, zIndex: index },
      bone,
    })),
  );
  for (const parts of Object.values(model.skins[0]!.attachments))
    for (const mesh of Object.values(parts)) {
      for (const vertex of mesh.vertices.bindings)
        expect(vertex.reduce((sum, binding) => sum + binding.weight, 0)).toBeCloseTo(1);
    }
});

test("completion pixels follow local body bones while floor coverage stays fixed", async () => {
  const joints = defaultRigJoints();
  joints[3]!.x = joints[4]!.x;
  joints[3]!.y = joints[4]!.y;
  const model = await createRigTestModel(1000, 1500, joints, [
    { ...bindings[0]!, bone: "completion" },
  ]);
  const mesh = model.skins[0]!.attachments["layer-0"]!["layer-0"]!;
  expect(mesh.vertices.bindings.length).toBeGreaterThan(3000);
  const bones = new Set(
    mesh.vertices.bindings.flatMap((vertex) => vertex.map((binding) => binding.bone)),
  );
  expect(bones.has("root")).toBe(true);
  expect(bones.has("hand_l")).toBe(true);
  expect(bones.has("head")).toBe(true);
});

test("role suggestions use geometry for screen side and expose unclassified parts", () => {
  const layer = bindings[1]!.layer;
  for (const [name, prefix] of [
    ["Right Forearm", "forearm"],
    ["Upper Arm", "upperarm"],
    ["Hand", "hand"],
    ["Lower Leg", "shin"],
    ["Thigh", "thigh"],
    ["Boot", "foot"],
  ] as const) {
    expect(suggestedRigBone({ ...layer, name }, 1000)).toBe(prefix + "_l");
    expect(suggestedRigBone({ ...layer, name, bounds: [600, 0, 800, 100] }, 1000)).toBe(
      prefix + "_r",
    );
  }
  expect(suggestedRigBone({ ...layer, name: "Hair" }, 1000)).toBe("head");
  expect(suggestedRigBone({ ...layer, name: "Torso costume" }, 1000)).toBe("chest");
  expect(suggestedRigBone({ ...layer, name: "Source visible completion" }, 1000)).toBe(
    "completion",
  );
  expect(suggestedRigBone(bindings[0]!.layer, 1000)).toBe("root");
  expect(suggestedRigBone({ ...layer, name: "Unknown accessory" }, 1000)).toBe("");
});
