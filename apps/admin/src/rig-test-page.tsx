import { renderToStaticMarkup } from "react-dom/server";
import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import { AdminLayout } from "./admin-layout.tsx";
import { html } from "./html-response.ts";
import { requestId } from "./logging.ts";
import { artworkPageSource } from "./artwork-page-source.ts";
import { rigLayerBones, suggestedRigBone } from "./rig-test-binding.ts";
import { defaultRigJoints } from "./rig-test-model.ts";
import { RigFacePanel } from "./rig-face-panel.tsx";
import { RigFaceControls } from "./rig-face-controls.tsx";
import { rigLayerPlane, missingFaceParts } from "./rig-face.ts";

declare const ADMIN_ASSETS: { rigScript: string };

export async function rigTestPage(request: Request, url: URL, store: PersonaStore) {
  const loaded = await artworkPageSource(request, url, store);
  if (loaded instanceof Response) return loaded;
  const { id, persona, artwork } = loaded;
  const layers = artwork.layers;
  if (!layers) throw new PersonaError("not_found", "먼저 현재 원화의 레이어를 분리해 주세요.");
  const assets = [
    { group: "body", label: "몸", result: layers },
    ...(artwork.outfit?.layers
      ? [{ group: "outfit", label: "의상", result: artwork.outfit.layers }]
      : []),
  ];
  return html(
    renderToStaticMarkup(
      <AdminLayout
        active="personas"
        title={`${persona.name} · rig-c 테스트 · RenAI`}
        script={ADMIN_ASSETS.rigScript}
      >
        <main
          id="main"
          className="rig-test"
          data-rig-test
          data-request-id={requestId()}
          data-rig-width={layers.width}
          data-rig-height={layers.height}
          data-face-parts={JSON.stringify(layers.faceParts ?? [])}
        >
          <header className="rig-test-header">
            <a href={`/personas/${id}`}>← 페르소나 편집</a>
            <h1>{persona.name} · rig-c 테스트</h1>
            <p>
              분리된 {assets.reduce((count, asset) => count + asset.result.layers.length, 0)}개
              PNG를 관절에 연결한 레이어 리그 테스트입니다.
            </p>
            {artwork.kind !== "body" && (
              <p className="hint">
                이 결과는 이전 착의 원화를 분리한 것입니다. 새 몸·의상 제작 흐름을 검증하려면 편집
                화면에서 속옷 차림 기본 몸부터 생성하세요.
              </p>
            )}
            <p className="hint">
              팔꿈치를 움직이면 아래팔과 손이 함께 회전합니다. 크게 굽힌 자세에서 연결부의 틈·겹침을
              확인하세요. 관절 위치와 연결 변경은 이 페이지에만 적용됩니다. 표정은 별도 얼굴 부품을
              준비한 뒤 사용할 수 있습니다. 머리카락 물리 효과는 포함하지 않습니다.
            </p>
          </header>
          <div className="rig-test-controls rig-preview-controls">
            <label>
              보기
              <select data-rig-comparison defaultValue="live">
                <option value="live">실제 상체 · 표정과 동작</option>
                <option value="original">A · 원본</option>
                <option value="flat">B · PNG 재합성</option>
                <option value="rig">C · 정지 리그</option>
                <option value="motion">D · 동작 리그</option>
              </select>
            </label>
            <label>
              구도
              <select data-rig-framing defaultValue="portrait">
                <option value="portrait">상체 · 머리끝 포함</option>
                <option value="full">전신 · 제작 검수</option>
              </select>
            </label>
            <label>
              검수 배경
              <select data-rig-backdrop defaultValue="#ffffff">
                <option value="#ffffff">흰색</option>
                <option value="#657077">회색 · 투명 경계</option>
                <option value="#151a1e">어두운색 · 테두리</option>
              </select>
            </label>
          </div>
          <RigFaceControls layers={layers} />
          <section className="rig-preview" aria-labelledby="rig-player-title">
            <h2 id="rig-player-title">상체 미리보기</h2>
            <p className="hint">
              A→B는 분리 이미지, B→C는 재생, C→D는 변형의 손실을 같은 구도에서 비교합니다. A–D에서는
              몸만 표시하고 표정을 교체하지 않습니다.
            </p>
            <figure
              className="rig-test-stage"
              data-rig-stage
              aria-label={`${persona.name}의 상체 움직임 검수`}
            >
              <div data-rig-player />
            </figure>
            <output data-rig-status>원화와 rig-c 재생기를 불러오는 중…</output>
          </section>
          <details className="rig-inspector">
            <summary>얼굴·머리카락 자산 제작</summary>
            <RigFacePanel id={id} source={artwork.operationId} layers={layers} />
          </details>
          <details className="rig-inspector">
            <summary>제작 검수 · 동작·관절·레이어</summary>
            <div className="rig-test-controls">
              <label>
                표시 대상
                <select data-rig-view defaultValue="all">
                  <option value="all">전체 · 몸 + 의상</option>
                  <option value="body">몸만</option>
                  <option value="outfit" disabled={!artwork.outfit?.layers}>
                    의상만
                  </option>
                </select>
              </label>
              <label>
                테스트 동작
                <select
                  data-rig-motion
                  defaultValue={
                    missingFaceParts(layers.faceParts ?? []).length === 0 ? "idle" : "elbows"
                  }
                >
                  <option value="rest">원래 자세</option>
                  <option value="idle">대기 · 미세 움직임</option>
                  <option value="nod">고개 기울이기</option>
                  <option value="elbows">팔꿈치 굽히기</option>
                  <option value="knees">무릎 굽히기</option>
                </select>
              </label>
              <label>
                움직임 강도
                <input
                  data-rig-strength
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue="0.75"
                />
              </label>
              <button type="button" data-rig-pause disabled>
                일시정지
              </button>
              <button type="button" data-rig-restart className="secondary" disabled>
                처음부터
              </button>
              <button type="button" data-rig-reset className="secondary" disabled>
                관절 초기화
              </button>
              <button type="button" data-rig-rest className="secondary" disabled>
                원래 자세로 고정
              </button>
              <button type="button" data-rig-bent className="secondary" disabled>
                굽힌 자세로 고정
              </button>
              <button type="button" data-rig-head-left className="secondary" disabled>
                고개 왼쪽 고정
              </button>
              <button type="button" data-rig-head-right className="secondary" disabled>
                고개 오른쪽 고정
              </button>
            </div>
            <div className="rig-source-editor">
              <section aria-labelledby="rig-source-title">
                <h2 id="rig-source-title">원본 · 관절 위치</h2>
                <p className="hint">번호를 드래그하거나 초점을 맞추고 방향키로 이동하세요.</p>
                <div className="rig-test-source" data-rig-source-area>
                  <img
                    data-rig-source
                    src={artwork.imageUrl}
                    alt={`${persona.name}의 현재 전신 원화`}
                  />
                  <div
                    data-rig-joints
                    data-joint-positions={JSON.stringify(layers.jointPositions ?? [])}
                  />
                </div>
                <output data-rig-joint-status aria-live="polite" />
                <ol className="rig-joint-legend">
                  {defaultRigJoints().map((joint) => (
                    <li key={joint.name}>{joint.label}</li>
                  ))}
                </ol>
              </section>
            </div>
            <section className="rig-layer-bindings" aria-label="레이어 관절 연결">
              <h2>레이어 관절 연결</h2>
              <p className="hint">
                이름과 화면상의 위치를 기준으로 제안한 연결입니다. 잘못 연결된 부품은 변경하세요.
                원본 보충 레이어는 부위별로 가까운 관절에 가중 연결합니다. 변형 중 드러나는 가려진
                면과 연결부는 추가 정리가 필요할 수 있습니다. 배경과 원본 보충 레이어는 잔여 인물
                픽셀이 떠다니지 않도록 기본적으로 숨깁니다. 필요한 부품만 개별 표시해 확인하세요.
              </p>
              <div className="rig-layer-binding-list">
                {assets.flatMap(({ group, label, result }) =>
                  result.layers.map((original) => {
                    const layer = {
                      ...original,
                      bounds: [
                        (original.bounds[0] * layers.width) / result.width,
                        (original.bounds[1] * layers.height) / result.height,
                        (original.bounds[2] * layers.width) / result.width,
                        (original.bounds[3] * layers.height) / result.height,
                      ] as const,
                    };
                    const bone = suggestedRigBone(layer, layers.width);
                    return (
                      <div
                        key={`${group}-${layer.zIndex}`}
                        data-rig-layer
                        data-rig-group={group}
                        data-rig-texture={`${group}-${layer.zIndex}`}
                        data-z-index={layer.zIndex}
                        data-layer-name={layer.name}
                        data-layer-plane={rigLayerPlane(layer, group)}
                        data-layer-bone={layer.bone}
                        data-image-url={layer.imageUrl}
                        data-image-width={layer.width}
                        data-image-height={layer.height}
                        data-left={layer.bounds[0]}
                        data-top={layer.bounds[1]}
                        data-right={layer.bounds[2]}
                        data-bottom={layer.bounds[3]}
                      >
                        <label>
                          {label} · {layer.name}
                          <select data-rig-layer-bone defaultValue={bone}>
                            <option value="">관절 연결 선택</option>
                            {rigLayerBones.map(([name, boneLabel]) => (
                              <option key={name} value={name}>
                                {boneLabel}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            data-rig-layer-enabled
                            defaultChecked={layer.zIndex !== 0 && bone !== "completion"}
                          />
                          표시
                        </label>
                      </div>
                    );
                  }),
                )}
              </div>
            </section>
          </details>
          <p className="hint">
            사용한 원화: <code>{artwork.model}</code> ·{" "}
            <a href={artwork.imageUrl} target="_blank" rel="noreferrer">
              원본 열기
            </a>
            . 이 페이지에서는 이미지 생성 API를 호출하지 않습니다.
          </p>
        </main>
      </AdminLayout>,
    ),
  );
}
