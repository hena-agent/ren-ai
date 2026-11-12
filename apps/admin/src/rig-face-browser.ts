import type { RigPlayer } from "@rig-c/play";
import type { RigFacePart } from "@ren-ai/personas/rig-artwork";
import { visibleFaceSlots, faceExpressions } from "./rig-face.ts";
import { faceGaze } from "./rig-face-gaze.ts";

export function bindRigFace(
  page: HTMLElement,
  player: Pick<RigPlayer, "slots" | "adjust" | "repose" | "frame">,
  parts: readonly RigFacePart[],
  width: number,
) {
  const controls = page.querySelector<HTMLElement>("[data-rig-face-controls]")!;
  const expression = controls.querySelector<HTMLSelectElement>("[data-rig-expression]")!;
  const blink = controls.querySelector<HTMLSelectElement>("[data-rig-blink]")!;
  const mouth = controls.querySelector<HTMLInputElement>("[data-rig-mouth]")!;
  const x = controls.querySelector<HTMLInputElement>("[data-rig-gaze-x]")!;
  const y = controls.querySelector<HTMLInputElement>("[data-rig-gaze-y]")!;
  let time = 0;
  let previous = "";
  const halfReady = ["eye-left", "eye-right", "pupil-left", "pupil-right"].every((role) =>
    parts.some((part) => part.role === role && part.state === "half"),
  );
  const update = (dt: number) => {
    time = (time + dt) % 4;
    const expressionState = faceExpressions.find(([value]) => value === expression.value)![0];
    const emotionClosed = ["eye-left", "eye-right"].every((role) =>
      parts.some((part) => part.role === role && part.state === expressionState && part.closed),
    );
    let eyelid: "neutral" | "half" | "closed" =
      blink.value === "half" ? "half" : blink.value === "closed" ? "closed" : "neutral";
    if (blink.value === "auto" && !emotionClosed) {
      if (time >= 3.8 && (!halfReady || time < 3.94)) eyelid = "closed";
      else if (halfReady && time >= 3.72) eyelid = "half";
    }
    const slots = visibleFaceSlots(parts, expressionState, eyelid, mouth.checked);
    const key = slots.join(",");
    if (key === previous) return;
    previous = key;
    const selected = new Set(slots);
    player.slots = (slot) => {
      const target = slot.endsWith("-clip") ? slot.slice(0, -5) : slot;
      return !target.startsWith("face-") || selected.has(target);
    };
    player.frame(0);
  };
  const change = () => {
    previous = "";
    const gaze = faceGaze(
      parts,
      faceExpressions.find(([value]) => value === expression.value)![0],
      Number(x.value),
      Number(y.value),
      width,
    );
    x.disabled = y.disabled = !gaze.ready;
    player.adjust = (bones) => {
      for (const offset of gaze.offsets) {
        const pupil = bones.bone(offset.bone);
        pupil.x += offset.x;
        pupil.y += offset.y;
      }
    };
    player.repose();
    update(0);
  };
  controls.addEventListener("input", change);
  change();
  return { tick: update, dispose: () => controls.removeEventListener("input", change) };
}
