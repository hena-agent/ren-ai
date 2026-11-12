import type { RigFacePart } from "@ren-ai/personas/rig-artwork";
import { faceSlot, visibleFaceSlots } from "./rig-face.ts";

export function faceGaze(
  parts: readonly RigFacePart[],
  expression: RigFacePart["state"],
  x: number,
  y: number,
  width: number,
) {
  const shown = new Set(visibleFaceSlots(parts, expression, "neutral", false));
  const pupils = parts.filter((part) => part.role.startsWith("pupil") && shown.has(faceSlot(part)));
  const ready = pupils.length === 2 && pupils.every((part) => part.aperture && part.gaze);
  const scale = 1000 / width;
  return {
    ready,
    offsets: pupils.map((part) => ({
      bone: part.role,
      x: ready ? Math.max(-1, Math.min(1, x)) * part.gaze!.x * scale : 0,
      y: ready ? -Math.max(-1, Math.min(1, y)) * part.gaze!.y * scale : 0,
    })),
  };
}
