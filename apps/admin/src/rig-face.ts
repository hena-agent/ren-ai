import type { RigArtworkLayer, RigFacePart } from "@ren-ai/personas/rig-artwork";
import type { RigLayerBinding } from "./rig-test-model.ts";

export const faceRoles = [
  ["base", "얼굴 바탕·귀·목"],
  ["eye-left", "화면 왼쪽 눈 흰자·눈꺼풀"],
  ["eye-right", "화면 오른쪽 눈 흰자·눈꺼풀"],
  ["pupil-left", "화면 왼쪽 눈동자"],
  ["pupil-right", "화면 오른쪽 눈동자"],
  ["lid-left", "화면 왼쪽 눈꺼풀 덮개 · 선택"],
  ["lid-right", "화면 오른쪽 눈꺼풀 덮개 · 선택"],
  ["brow-left", "화면 왼쪽 눈썹"],
  ["brow-right", "화면 오른쪽 눈썹"],
  ["mouth", "입"],
] as const;
export const faceExpressions = [
  ["neutral", "평상"],
  ["happy", "반가움"],
  ["thinking", "생각 중"],
  ["worried", "걱정"],
  ["surprised", "놀람"],
] as const;
export const faceGenerationLabels = {
  base: "얼굴 바탕 복원",
  closed: "감긴 눈·미소",
  surprised: "놀란 눈·벌린 입",
};
export const layerPlanes = [
  ["behind-body", "몸 뒤 머리카락"],
  ["body", "공통 몸"],
  ["outfit", "의상"],
  ["face", "얼굴·목"],
  ["front-body", "몸 앞 머리카락"],
  ["front-face", "얼굴 위 앞머리"],
] as const;

export function rigLayerPlane(layer: RigArtworkLayer, group: string) {
  if (layer.plane) return layer.plane;
  if (group === "outfit") return "outfit";
  if (/back.?hair/i.test(layer.name)) return "behind-body";
  if (/front.?hair|hair/i.test(layer.name)) return "front-face";
  if (/face|head/i.test(layer.name)) return "face";
  return "body";
}

export function missingFaceParts(parts: readonly RigFacePart[]) {
  return faceRoles.filter(
    ([role]) =>
      !role.startsWith("lid") &&
      !parts.some((part) => part.role === role && part.state === "neutral"),
  );
}

export function faceStateAllowed(role: RigFacePart["role"], state: RigFacePart["state"]) {
  if (role === "base") return state === "neutral";
  if (role.startsWith("pupil"))
    return state === "half" || faceExpressions.some(([value]) => value === state);
  if (state === "half") return role.startsWith("eye") || role.startsWith("lid");
  if (state === "closed") return role.startsWith("eye");
  if (state === "open") return role === "mouth";
  return true;
}

export function faceExpressionReady(parts: readonly RigFacePart[], state: RigFacePart["state"]) {
  if (state === "neutral") return missingFaceParts(parts).length === 0;
  return ["eye-left", "eye-right", "brow-left", "brow-right", "mouth"].every((role) =>
    parts.some((part) => part.role === role && part.state === state),
  );
}

export function faceSlot(part: RigFacePart) {
  return `face-${part.role}-${part.state}`;
}
const planeRank = (plane: RigArtworkLayer["plane"]) =>
  layerPlanes.findIndex(([value]) => value === plane);

export function composeFaceBindings(
  bindings: readonly RigLayerBinding[],
  parts: readonly RigFacePart[],
  width: number,
  height: number,
): RigLayerBinding[] {
  const features: RigLayerBinding[] = parts
    .toSorted(
      (a, b) =>
        faceRoles.findIndex(([role]) => role === a.role) -
        faceRoles.findIndex(([role]) => role === b.role),
    )
    .map((part) => {
      const bounds = part.bounds ?? ([0, 0, width, height] as const);
      return {
        layer: {
          name: part.role === "base" ? "Face and Neck" : part.role,
          zIndex: 0,
          width: bounds[2] - bounds[0],
          height: bounds[3] - bounds[1],
          bounds,
          imageUrl: part.imageUrl,
          plane: "face",
        },
        bone: part.role.startsWith("pupil") ? part.role : "head",
        texture: faceSlot(part),
        ...(part.role.startsWith("pupil") && part.aperture && { clip: part.aperture }),
      };
    });
  return [...bindings, ...features].toSorted(
    (a, b) => planeRank(a.layer.plane) - planeRank(b.layer.plane),
  );
}

export function visibleFaceSlots(
  parts: readonly RigFacePart[],
  expression: RigFacePart["state"],
  blink: "neutral" | "half" | "closed",
  mouthOpen: boolean,
) {
  const stateFor = (role: RigFacePart["role"]) => {
    let state = expression;
    if (role === "base") state = "neutral";
    if (role.startsWith("eye") && blink !== "neutral") state = blink;
    if ((role.startsWith("pupil") || role.startsWith("lid")) && blink === "half") state = "half";
    if (role === "mouth" && mouthOpen) state = "open";
    if (!parts.some((candidate) => candidate.role === role && candidate.state === state))
      state = "neutral";
    return state;
  };
  const selected = parts.filter((part) => {
    if (part.state !== stateFor(part.role)) return false;
    if (!part.role.startsWith("pupil") && !part.role.startsWith("lid")) return true;
    if (blink === "closed") return false;
    if (
      blink === "half" &&
      !parts.some((candidate) => candidate.role === part.role && candidate.state === "half")
    )
      return false;
    const eye = part.role.endsWith("left") ? "eye-left" : "eye-right";
    return !parts.some(
      (candidate) =>
        candidate.role === eye && candidate.state === stateFor(eye) && candidate.closed,
    );
  });
  return selected.map(faceSlot);
}
