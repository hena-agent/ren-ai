import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";
import { completionGeometry } from "./rig-test-completion.ts";
import { limbGeometry } from "./rig-test-limb.ts";
import { eyeClipping } from "./rig-test-clipping.ts";
import { hairMotionBone, hairGeometry } from "./rig-test-hair.ts";

export interface RigJoint {
  name: string;
  label: string;
  parent: string;
  x: number;
  y: number;
}
export interface RigLayerBinding {
  layer: RigArtworkLayer;
  bone: string;
  texture?: string;
  clip?: readonly (readonly [number, number])[];
}

export function defaultRigJoints(
  positions: readonly { name: string; x: number; y: number }[] = [],
): RigJoint[] {
  const joints = [
    { name: "hip", label: "골반", parent: "root", x: 0.5, y: 0.5 },
    { name: "chest", label: "가슴", parent: "hip", x: 0.5, y: 0.33 },
    { name: "head", label: "목 밑", parent: "chest", x: 0.5, y: 0.19 },
    { name: "upperarm_l", label: "화면 왼쪽 어깨", parent: "chest", x: 0.39, y: 0.21 },
    { name: "forearm_l", label: "화면 왼쪽 팔꿈치", parent: "upperarm_l", x: 0.342, y: 0.345 },
    { name: "hand_l", label: "화면 왼쪽 손목", parent: "forearm_l", x: 0.245, y: 0.435 },
    { name: "upperarm_r", label: "화면 오른쪽 어깨", parent: "chest", x: 0.625, y: 0.21 },
    { name: "forearm_r", label: "화면 오른쪽 팔꿈치", parent: "upperarm_r", x: 0.666, y: 0.345 },
    { name: "hand_r", label: "화면 오른쪽 손목", parent: "forearm_r", x: 0.746, y: 0.435 },
    { name: "thigh_l", label: "화면 왼쪽 고관절", parent: "hip", x: 0.4, y: 0.52 },
    { name: "shin_l", label: "화면 왼쪽 무릎", parent: "thigh_l", x: 0.391, y: 0.66 },
    { name: "foot_l", label: "화면 왼쪽 발목", parent: "shin_l", x: 0.395, y: 0.82 },
    { name: "thigh_r", label: "화면 오른쪽 고관절", parent: "hip", x: 0.577, y: 0.52 },
    { name: "shin_r", label: "화면 오른쪽 무릎", parent: "thigh_r", x: 0.585, y: 0.66 },
    { name: "foot_r", label: "화면 오른쪽 발목", parent: "shin_r", x: 0.618, y: 0.82 },
  ];
  return joints.map((joint) => {
    const position = positions.find((candidate) => candidate.name === joint.name);
    return position ? { ...joint, x: position.x, y: position.y } : joint;
  });
}

function waveKey(time: number, amount: number, base = 0) {
  const value = base + Math.sin((time * Math.PI) / 2) * amount;
  if (time === 4) return { time, value };
  return {
    time,
    value,
    curve: [
      time + 1 / 3,
      value + ((amount * Math.PI) / 6) * Math.cos((time * Math.PI) / 2),
      time + 2 / 3,
      base +
        Math.sin(((time + 1) * Math.PI) / 2) * amount -
        ((amount * Math.PI) / 6) * Math.cos(((time + 1) * Math.PI) / 2),
    ],
  };
}

const motion = (name: string, targets: readonly (readonly [string, number])[]) => ({
  name,
  duration: 4,
  bones: targets.map(([bone, amount]) => ({
    name: bone,
    timelines: [
      {
        name: "rotate",
        keys: [0, 1, 2, 3, 4].map((time) => waveKey(time, amount)),
      },
    ],
  })),
  slots: [],
  constraints: { ik: [], transform: [], path: [], physics: [], slider: [] },
  attachments: [],
  drawOrder: [],
  events: [],
});

/** Each separated PNG owns a slot and texture; adjoining limbs share a skinning field. */
export async function createRigTestModel(
  width: number,
  height: number,
  joints: readonly RigJoint[],
  bindings: readonly RigLayerBinding[],
) {
  const scale = 1000 / width,
    rigHeight = height * scale;
  const positions = new Map([
    ["root", { x: 0, y: 0 }],
    ...joints.map(
      (joint) => [joint.name, { x: joint.x * 1000, y: (1 - joint.y) * rigHeight }] as const,
    ),
  ]);
  const pupils = ["pupil-left", "pupil-right"].filter((name) =>
    bindings.some((binding) => binding.bone === name),
  );
  const hairBones = [
    ...new Set(
      bindings
        .filter((binding) => binding.bone === "head")
        .map((binding) => hairMotionBone(binding.layer))
        .filter((bone) => bone !== undefined),
    ),
  ];
  for (const name of pupils) positions.set(name, positions.get("head")!);
  const bones = [
    { name: "root", x: 0, y: 0 },
    ...joints.map((joint) => {
      const point = positions.get(joint.name)!,
        parent = positions.get(joint.parent)!;
      return {
        name: joint.name,
        parent: joint.parent,
        x: point.x - parent.x,
        y: point.y - parent.y,
      };
    }),
  ];
  bones.push(...pupils.map((name) => ({ name, parent: "head", x: 0, y: 0 })));
  bones.push(...hairBones.map((name) => ({ name, parent: "head", x: 0, y: 0 })));
  const parts = bindings.map(({ layer, bone, texture, clip }) => {
    const origin = positions.get(bone === "completion" ? "root" : bone);
    if (!origin) throw new Error(`레이어의 관절 연결을 선택하세요: ${layer.name}`);
    const [left, top, right, bottom] = layer.bounds;
    const vertices = [
      [left, top],
      [left, bottom],
      [right, bottom],
      [right, top],
    ].map(([x, y]) => [
      { bone, x: x! * scale - origin.x, y: rigHeight - y! * scale - origin.y, weight: 1 },
    ]);
    const name = texture ?? `layer-${layer.zIndex}`;
    const attachment = {
      kind: "mesh" as const,
      path: name,
      uvs: [0, 0, 0, 1, 1, 1, 1, 0],
      triangles: [0, 1, 2, 0, 2, 3],
      vertices: { weighted: true, bindings: vertices },
      hull: 4,
      edges: [],
      width: (right - left) * scale,
      height: (bottom - top) * scale,
      ...(bone === "completion" && completionGeometry(layer, joints, positions, width, height)),
      ...limbGeometry(layer, bone, positions, width, height),
      ...(bone === "head" && hairGeometry(layer, positions, width, height)),
    };
    return {
      name,
      layer,
      bone,
      attachment,
      clip: eyeClipping(
        name,
        clip,
        positions.get("head")!,
        bones.findIndex((candidate) => candidate.name === "head"),
        width,
        height,
      ),
    };
  });
  const slots = parts.flatMap((part) => {
    const mesh = { name: part.name, bone: "root", setup: part.name };
    return part.clip ? [part.clip.slot, mesh] : [mesh];
  });
  type Attachment =
    | (typeof parts)[number]["attachment"]
    | NonNullable<ReturnType<typeof eyeClipping>>["attachment"];
  type SpineAttachment =
    | (Pick<
        (typeof parts)[number]["attachment"],
        "path" | "uvs" | "triangles" | "hull" | "width" | "height"
      > & { type: string; vertices: number[] })
    | NonNullable<ReturnType<typeof eyeClipping>>["spine"];
  const attachments: Record<string, Record<string, Attachment>> = {};
  for (const part of parts) {
    attachments[part.name] = { [part.name]: part.attachment };
    if (part.clip) attachments[part.clip.name] = { [part.clip.name]: part.clip.attachment };
  }
  const idle = motion("idle", [
    ["chest", 0.35],
    ["head", -0.25],
    ...hairBones.map((name) => [name, name === "hair-front" ? 0.3 : 0.15] as const),
  ]);
  idle.bones
    .find((bone) => bone.name === "chest")!
    .timelines.push({
      name: "scaley",
      keys: [0, 1, 2, 3, 4].map((time) => waveKey(time, 0.002, 1)),
    });
  for (const [name, amount] of [
    ["upperarm_l", 5],
    ["upperarm_r", -5],
  ] as const)
    idle.bones.push({
      name,
      timelines: [
        {
          name: "rotate",
          keys: [
            { time: 0, value: amount },
            { time: 4, value: amount },
          ],
        },
      ],
    });
  const animations = [
    motion("rest", [["chest", 0]]),
    idle,
    motion("nod", [
      ["head", 12],
      ...hairBones.map((name) => [name, name === "hair-front" ? -3 : -1.5] as const),
    ]),
    motion("elbows", [
      ["forearm_l", -60],
      ["forearm_r", 60],
    ]),
    motion("knees", [
      ["shin_l", -30],
      ["shin_r", 30],
    ]),
  ];
  const spine = {
    skeleton: { spine: "4.3.13", x: 0, y: 0, width: 1000, height: rigHeight },
    bones,
    slots: slots.map(({ setup, ...slot }) => ({ ...slot, attachment: setup })),
    skins: [
      {
        name: "default",
        attachments: Object.fromEntries<Record<string, SpineAttachment>>(
          parts.flatMap<readonly [string, Record<string, SpineAttachment>]>((part) => {
            const mesh = [
              part.name,
              {
                [part.name]: {
                  type: "mesh",
                  path: part.name,
                  uvs: part.attachment.uvs,
                  triangles: part.attachment.triangles,
                  hull: part.attachment.hull,
                  width: part.attachment.width,
                  height: part.attachment.height,
                  vertices: part.attachment.vertices.bindings.flatMap((vertex) => [
                    vertex.length,
                    ...vertex.flatMap((binding) => [
                      bones.findIndex((candidate) => candidate.name === binding.bone),
                      binding.x,
                      binding.y,
                      binding.weight,
                    ]),
                  ]),
                },
              },
            ] as const;
            return part.clip
              ? [[part.clip.name, { [part.clip.name]: part.clip.spine }] as const, mesh]
              : [mesh];
          }),
        ),
      },
    ],
    animations: Object.fromEntries(
      animations.map((animation) => [
        animation.name,
        {
          bones: Object.fromEntries(
            animation.bones.map((bone) => [
              bone.name,
              Object.fromEntries(bone.timelines.map((timeline) => [timeline.name, timeline.keys])),
            ]),
          ),
        },
      ]),
    ),
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(spine)),
  );
  return {
    spec: "rigc-compiled/3",
    referenceScale: 100,
    stage: { x: 0, y: 0, width: 1000, height: rigHeight },
    bones,
    slots,
    skins: [{ name: "default", bones: [], constraints: {}, attachments }],
    constraints: [],
    events: [],
    animations,
    editorOrder: {
      skins: [{ name: "default", slots: slots.map((slot) => slot.name) }],
      animations: animations.map((animation) => animation.name),
    },
    images: [],
    pageGrids: [],
    droppedStates: [],
    absentParts: [],
    meshBones: [],
    meshes: [],
    physics: [],
    deformTransforms: [],
    trackDerivations: [],
    rig: {},
    pages: parts.map(({ name, layer }) => ({
      name,
      width: layer.width,
      height: layer.height,
      pma: false,
      scale: null,
      regions: [
        {
          name,
          x: 0,
          y: 0,
          width: layer.width,
          height: layer.height,
          offsetX: 0,
          offsetY: 0,
          originalWidth: layer.width,
          originalHeight: layer.height,
          degrees: 0,
          index: -1,
        },
      ],
    })),
    spine: {
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    },
  };
}
