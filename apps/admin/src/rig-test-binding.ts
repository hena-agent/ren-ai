import type { RigArtworkLayer } from "@ren-ai/personas/rig-artwork";

export const rigLayerBones = [
  ["completion", "원본 보충 · 부위별 가중 연결"],
  ["root", "고정 · 배경/보충"],
  ["hip", "골반"],
  ["chest", "몸통"],
  ["head", "머리·목"],
  ["upperarm_l", "화면 왼쪽 위팔"],
  ["forearm_l", "화면 왼쪽 아래팔"],
  ["hand_l", "화면 왼쪽 손"],
  ["upperarm_r", "화면 오른쪽 위팔"],
  ["forearm_r", "화면 오른쪽 아래팔"],
  ["hand_r", "화면 오른쪽 손"],
  ["thigh_l", "화면 왼쪽 허벅지"],
  ["shin_l", "화면 왼쪽 종아리"],
  ["foot_l", "화면 왼쪽 발"],
  ["thigh_r", "화면 오른쪽 허벅지"],
  ["shin_r", "화면 오른쪽 종아리"],
  ["foot_r", "화면 오른쪽 발"],
] as const;

export function suggestedRigBone(layer: RigArtworkLayer, width: number) {
  if (layer.bone) return layer.bone;
  if (/source visible completion/i.test(layer.name)) return "completion";
  if (layer.zIndex === 0 || /background|\bbase\b/i.test(layer.name)) return "root";
  const side = (layer.bounds[0] + layer.bounds[2]) / 2 < width / 2 ? "_l" : "_r";
  const roles: readonly (readonly [RegExp, string])[] = [
    [/forearm|elbow-to-wrist/i, "forearm"],
    [/upper.?arm|shoulder-to-elbow/i, "upperarm"],
    [/hand/i, "hand"],
    [/lower.?leg|shin|calf/i, "shin"],
    [/thigh/i, "thigh"],
    [/foot|boot/i, "foot"],
  ];
  const limb = roles.find(([pattern]) => pattern.test(layer.name));
  if (limb) return limb[1] + side;
  if (/hair|head|face/i.test(layer.name)) return "head";
  if (/torso|neck|costume|body/i.test(layer.name)) return "chest";
  return "";
}
