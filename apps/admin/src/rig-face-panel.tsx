import type { RigArtworkLayers } from "@ren-ai/personas/rig-artwork";
import {
  faceRoles,
  faceExpressions,
  layerPlanes,
  missingFaceParts,
  rigLayerPlane,
} from "./rig-face.ts";
import { faceGaze } from "./rig-face-gaze.ts";

function Options({ choices }: { choices: readonly (readonly [string, string])[] }) {
  return choices.map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

export function RigFacePanel({
  id,
  source,
  layers,
}: {
  id: string;
  source: string;
  layers: RigArtworkLayers;
}) {
  const parts = layers.faceParts ?? [];
  const missing = missingFaceParts(parts);
  const gazeReady = faceGaze(parts, "neutral", 0, 0, layers.width).ready;
  const blinkReady = ["eye-left", "eye-right"].every((role) =>
    parts.some((part) => part.role === role && part.state === "closed"),
  );
  const receipt = (
    <>
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="result" value={layers.operationId} />
    </>
  );
  return (
    <section className="rig-face-panel" aria-labelledby="rig-face-title">
      <h2 id="rig-face-title">공통 몸 · 얼굴 제작</h2>
      {!!layers.faceSources?.length && (
        <details>
          <summary>생성한 얼굴 편집 결과 · {layers.faceSources.length}장</summary>
          <p>
            편집 화면의 얼굴 생성 버튼으로 추가 제작합니다. 아래 결과는 아직 자동 적용하지 않은 부품
            추출용 원본입니다.
          </p>
          <div className="rig-face-parts">
            {layers.faceSources.map((generated) => (
              <a
                key={generated.operationId}
                href={generated.imageUrl}
                target="_blank"
                rel="noreferrer"
              >
                {generated.kind} · {generated.model} · 원본 보기
              </a>
            ))}
          </div>
        </details>
      )}
      <p>
        현재 몸·손·관절을 고정해 사용합니다. 머리카락의 앞·뒤는 시점이 아니라 몸·의상과 겹치는
        순서입니다.
      </p>
      <output>
        {missing.length
          ? `표정 준비 중 · 평상 부품 필요: ${missing.map(([, label]) => label).join(", ")}`
          : "평상 얼굴 부품 연결 가능 · 실제 외형 검수 필요"}
        {!blinkReady && " · 양쪽 감긴 눈 필요"}
      </output>
      {missing.length === 0 && !gazeReady && (
        <p className="hint">
          시선 이동에는 온전한 양쪽 홍채와 눈 안쪽 마스크·이동 범위가 필요합니다. 준비되지 않은
          눈동자는 이동시키지 않습니다.
        </p>
      )}
      <details>
        <summary>몸·머리카락 합성 위치 저장</summary>
        <form method="post" action={`/personas/${id}/rig-face`}>
          {receipt}
          <input type="hidden" name="action" value="planes" />
          <div className="rig-layer-binding-list">
            {layers.layers.map((layer) => (
              <label key={layer.zIndex}>
                {layer.name}
                <select name={`plane-${layer.zIndex}`} defaultValue={rigLayerPlane(layer, "body")}>
                  {layerPlanes.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button type="submit">합성 위치 저장</button>
        </form>
      </details>
      <details>
        <summary>얼굴 부품 등록 · {parts.length}장</summary>
        <p>
          원화와 같은 {layers.width}×{layers.height}px 투명 PNG를 사용하세요. 부품을 원래 좌표에
          두고 나머지는 투명하게 비웁니다. 얼굴 바탕에서는 눈·눈동자·눈썹·입을 지우고 피부를
          복원해야 합니다. 눈 부품과 눈동자는 따로 준비합니다.
        </p>
        <p>
          평상 부품 8장이 모두 준비되어야 기존 얼굴·목을 교체합니다. 없는 표정은 만들어진 것으로
          표시하지 않습니다. 기존 몸은 다시 생성하지 않습니다.
        </p>
        <form
          method="post"
          encType="multipart/form-data"
          action={`/personas/${id}/rig-face`}
          className="rig-test-controls"
        >
          {receipt}
          <label>
            부품
            <select name="role">
              <Options choices={faceRoles} />
            </select>
          </label>
          <label>
            상태
            <select name="state">
              <Options
                choices={[
                  ...faceExpressions,
                  ["half", "반쯤 감긴 눈"],
                  ["closed", "감긴 눈"],
                  ["open", "벌린 입"],
                ]}
              />
            </select>
          </label>
          <label>
            투명 PNG
            <input type="file" name="image" accept="image/png" required />
          </label>
          <label>
            <input type="checkbox" name="eyeClosed" />
            감긴 눈 부품 · 홍채와 열린 눈꺼풀 덮개 숨김
          </label>
          <button name="action" value="upload">
            부품 저장 · 유료 호출 없음
          </button>
        </form>
        <div className="rig-face-parts">
          {parts.map((part) => (
            <form
              key={`${part.role}-${part.state}`}
              method="post"
              action={`/personas/${id}/rig-face`}
            >
              {receipt}
              <input type="hidden" name="role" value={part.role} />
              <input type="hidden" name="state" value={part.state} />
              <a href={part.imageUrl} target="_blank" rel="noreferrer">
                {faceRoles.find(([role]) => role === part.role)![1]} · {part.state}
              </a>
              <button name="action" value="delete" className="secondary">
                제거
              </button>
            </form>
          ))}
        </div>
      </details>
    </section>
  );
}
