import { renderToStaticMarkup } from "react-dom/server";
import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import { AdminLayout } from "./admin-layout.tsx";
import { html } from "./html-response.ts";
import { artworkPageSource } from "./artwork-page-source.ts";
import { artworkTarget, artworkAsset } from "./rig-artwork-target.ts";

export async function artworkLayerPage(request: Request, url: URL, store: PersonaStore) {
  const loaded = await artworkPageSource(request, url, store);
  if (loaded instanceof Response) return loaded;
  const { id, persona } = loaded;
  const target = artworkTarget(url.searchParams.get("target"));
  const artwork = artworkAsset(loaded.artwork, target);
  if (!artwork) throw new PersonaError("not_found", "먼저 의상을 제작해 주세요.");
  const result = artwork.layers;
  if (!result || result.sourceOperationId !== artwork.operationId)
    throw new PersonaError("not_found", "현재 원화의 레이어 분리 결과가 없습니다.");
  const exported = {
    model: result.model,
    width: result.width,
    height: result.height,
    layers: result.layers,
    ...(result.sourceRepair && { sourceRepair: true }),
    ...(result.jointPositions && { jointPositions: result.jointPositions }),
  };
  if (url.searchParams.get("download") === "1")
    return Response.json(exported, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="artwork-layers.json"',
      },
    });
  return html(
    renderToStaticMarkup(
      <AdminLayout active="personas" title={`${persona.name} · 레이어 검수 · RenAI`}>
        <main id="main" className="artwork-layers" data-artwork-layers>
          <header className="rig-test-header">
            <a href={`/personas/${id}`}>← 페르소나 편집</a>
            <h1>
              {persona.name} · {target === "outfit" ? "의상" : "기본 몸"} 레이어 검수
            </h1>
            <a href={`/personas/${id}/rig-test`} target="_blank" rel="noreferrer">
              이 레이어로 움직임 테스트 ↗
            </a>
            <p>
              {result.layers.length}개 레이어 · {result.width} × {result.height} · Seedream 5 Pro
              Layerize
            </p>
            {result.sourceRepair && (
              <p className="hint">
                원본 기반 수작업 보정 적용: 팔다리 관절 경계와 보이는 원본의 누락 영역을 보정한
                결과입니다. 모델 원출력과 다르며, 가려진 부위·변형 품질은 별도 검수가 필요합니다.
              </p>
            )}
            <p className="hint">
              원본과 겹쳐 위치·누락·가려진 부분 복원을 확인하세요. 이 결과는 부품 분류와 리그 빌드
              전의 분리 결과입니다.
            </p>
          </header>
          <section className="layer-quality-panel" aria-label="원본 재합성 검사">
            <button type="button" className="secondary" data-layer-inspect>
              원본 대비 누락·색차 검사
            </button>
            <label>
              검사 표시
              <select data-layer-inspection-mode defaultValue="none">
                <option value="none">표시 안 함</option>
                <option value="missing">미덮임 영역 · 분홍색</option>
                <option value="difference">색차 영역 · 파란색</option>
              </select>
            </label>
            <output data-layer-quality aria-live="polite">
              검사 전 · 레이어 이름이나 개수만으로 리깅 적합성을 판정하지 않습니다.
            </output>
            <p className="hint">
              전체 레이어를 원본과 비교합니다. 미덮임은 원본의 비백색 영역 중 레이어 알파가 닿지
              않는 비율이며 그림자·정합 오차도 포함합니다. 수치만으로 자동 합격 처리하지 않습니다.
            </p>
          </section>
          <div className="layer-viewer-grid">
            <div>
              <div className="layer-stage">
                <svg
                  className="layer-canvas"
                  viewBox={`0 0 ${result.width} ${result.height}`}
                  width={result.width}
                  height={result.height}
                  aria-labelledby="layer-canvas-title"
                >
                  <title id="layer-canvas-title">{persona.name}의 레이어 재합성</title>
                  {result.layers.map((layer) => (
                    <image
                      key={layer.zIndex}
                      data-layer-image={layer.zIndex}
                      href={layer.imageUrl}
                      x={layer.bounds[0]}
                      y={layer.bounds[1]}
                      width={layer.bounds[2] - layer.bounds[0]}
                      height={layer.bounds[3] - layer.bounds[1]}
                      preserveAspectRatio="none"
                    >
                      <title>{layer.name}</title>
                    </image>
                  ))}
                  <image
                    data-layer-original
                    href={artwork.imageUrl}
                    display="none"
                    x={0}
                    y={0}
                    width={result.width}
                    height={result.height}
                    opacity={0.35}
                    preserveAspectRatio="none"
                  >
                    <title>비교할 원본 원화</title>
                  </image>
                </svg>
                <canvas
                  data-layer-inspection-overlay
                  className="layer-inspection-overlay"
                  hidden
                  aria-label="원본 누락 및 색차 검사 표시"
                />
              </div>
              <p className="hint">
                체크무늬는 투명 영역입니다. 원본을 겹치면 재합성 결과의 형태·위치 차이를 비교할 수
                있습니다.
              </p>
            </div>
            <section className="layer-viewer-controls" aria-label="레이어 표시 설정">
              <h2>레이어</h2>
              <p className="hint">
                위팔: 어깨→팔꿈치 / 아래팔: 팔꿈치→손목 / 손: 손목→손끝. 관절 끝은 약간 겹쳐야 하며,
                팔 전체를 한 조각으로 만든 결과는 재분리가 필요합니다.
              </p>
              <div className="form-actions">
                <button type="button" className="secondary" data-layers-all>
                  모두 표시
                </button>
                <button type="button" className="secondary" data-layers-none>
                  모두 숨기기
                </button>
              </div>
              <output data-layer-count aria-live="polite">
                {result.layers.length} / {result.layers.length}개 표시
              </output>
              <label className="toggle">
                <input type="checkbox" data-layer-compare />
                원본 겹치기
              </label>
              <label>
                원본 불투명도
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue="0.35"
                  data-layer-opacity
                />
              </label>
              <form method="post" action={`${url.pathname}/layout`} data-layer-layout-form>
                <h3>선택 레이어 위치 보정</h3>
                <input type="hidden" name="source" value={artwork.operationId} />
                <input type="hidden" name="rigArtworkTarget" value={target} />
                <input type="hidden" name="result" value={result.operationId} />
                <label>
                  보정할 레이어
                  <select
                    name="layer"
                    data-layer-layout-select
                    defaultValue={result.layers[1]!.zIndex}
                  >
                    {result.layers
                      .filter((layer) => layer.zIndex > 0)
                      .map((layer) => (
                        <option key={layer.zIndex} value={layer.zIndex}>
                          {layer.name}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="layer-layout-fields">
                  {["x", "y", "width", "height"].map((name, index) => (
                    <label key={name}>
                      {["왼쪽 X", "위쪽 Y", "너비", "높이"][index]}
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        name={name}
                        data-layer-layout-field={name}
                        defaultValue={
                          [
                            result.layers[1]!.bounds[0],
                            result.layers[1]!.bounds[1],
                            result.layers[1]!.bounds[2] - result.layers[1]!.bounds[0],
                            result.layers[1]!.bounds[3] - result.layers[1]!.bounds[1],
                          ][index]
                        }
                      />
                    </label>
                  ))}
                </div>
                <button type="submit" className="secondary">
                  위치 보정 저장
                </button>
                <p className="hint">
                  PNG·원화는 바꾸지 않고 배치만 저장합니다. 누락된 내용이나 잘못 분리된 신체 범위는
                  위치 보정으로 복구되지 않습니다.
                </p>
              </form>
              <ol className="layer-list">
                {result.layers.toReversed().map((layer) => (
                  <li key={layer.zIndex}>
                    <label>
                      <input type="checkbox" defaultChecked data-layer-toggle={layer.zIndex} />
                      <span>
                        {layer.name}
                        <small>
                          순서 {layer.zIndex} · {layer.width} × {layer.height}
                        </small>
                      </span>
                    </label>
                    <button type="button" className="secondary" data-layer-solo={layer.zIndex}>
                      단독
                    </button>
                    <a href={layer.imageUrl} target="_blank" rel="noreferrer">
                      PNG
                    </a>
                  </li>
                ))}
              </ol>
              <a href={`${url.pathname}?download=1&target=${target}`}>배치 정보 JSON 다운로드</a>
            </section>
          </div>
        </main>
      </AdminLayout>,
    ),
  );
}
