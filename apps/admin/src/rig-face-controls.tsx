import type { RigArtworkLayers } from "@ren-ai/personas/rig-artwork";
import { faceExpressions, missingFaceParts, faceExpressionReady } from "./rig-face.ts";
import { faceGaze } from "./rig-face-gaze.ts";

export function RigFaceControls({ layers }: { layers: RigArtworkLayers }) {
  const parts = layers.faceParts ?? [],
    missing = missingFaceParts(parts);
  const gaze = faceGaze(parts, "neutral", 0, 0, layers.width).ready;
  const blink = ["eye-left", "eye-right"].every((role) =>
    parts.some((part) => part.role === role && part.state === "closed"),
  );
  const half = ["eye-left", "eye-right", "pupil-left", "pupil-right"].every((role) =>
    parts.some((part) => part.role === role && part.state === "half"),
  );
  return (
    <fieldset
      className="rig-test-controls rig-face-controls"
      data-rig-face-controls
      aria-label="표정·시선"
    >
      <label>
        표정
        <select data-rig-expression disabled={missing.length > 0}>
          {faceExpressions.map(([value, label]) => (
            <option key={value} value={value} disabled={!faceExpressionReady(parts, value)}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        눈
        <select
          data-rig-blink
          defaultValue={blink ? "auto" : "neutral"}
          disabled={missing.length > 0 || !blink}
        >
          <option value="neutral">표정 기본</option>
          <option value="half" disabled={!half}>
            반쯤 감기
          </option>
          <option value="closed">감기</option>
          <option value="auto">자동 눈깜빡임</option>
        </select>
      </label>
      {[
        ["x", "시선 좌우"],
        ["y", "시선 상하"],
      ].map(([axis, label]) => (
        <label key={axis}>
          {label}
          <input
            {...{ [`data-rig-gaze-${axis}`]: true }}
            type="range"
            min="-1"
            max="1"
            step="0.1"
            defaultValue="0"
            disabled={missing.length > 0 || !gaze}
          />
        </label>
      ))}
      <label>
        <input
          data-rig-mouth
          type="checkbox"
          disabled={
            missing.length > 0 ||
            !parts.some((part) => part.role === "mouth" && part.state === "open")
          }
        />
        입 벌리기
      </label>
    </fieldset>
  );
}
