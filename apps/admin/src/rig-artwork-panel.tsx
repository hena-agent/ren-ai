import type { PersonaRecord, RigArtworkImage } from "@ren-ai/personas";
import type { Draft } from "./draft.ts";

function AssetActions({
  persona,
  image,
  target,
  reference,
  action,
  locked,
}: {
  persona: PersonaRecord;
  image?: RigArtworkImage | undefined;
  target: "body" | "outfit";
  reference?: string | undefined;
  action: string;
  locked: boolean;
}) {
  const label = target === "body" ? "기본 몸" : "의상";
  const imageLabel = target === "body" && image?.kind !== "body" ? "이전 착의 원화" : label;
  return (
    <section className="rig-asset-panel">
      <h3>{target === "body" ? "1. 속옷 차림 기본 몸" : "2. 몸 위에 입힐 의상"}</h3>
      {image && (
        <figure>
          <a
            href={image.imageUrl}
            target="_blank"
            rel="noreferrer"
            data-artwork-original={target === "body" ? "true" : undefined}
          >
            <img src={image.imageUrl} alt={`${persona.name}의 ${imageLabel} 원본`} loading="lazy" />
          </a>
          <figcaption>
            {image.model} ·{" "}
            <a href={image.imageUrl} target="_blank" rel="noreferrer">
              {imageLabel} 원본 열기
            </a>
          </figcaption>
        </figure>
      )}
      <div className="rig-layer-actions">
        <button
          type="submit"
          name="intent"
          value="rig-artwork"
          formAction={action}
          className="secondary"
          disabled={locked || !persona.name || !reference}
          data-portrait-operation={`rig-artwork:${target}`}
          data-rig-artwork-target="true"
          data-artwork-target={target}
          data-artwork-reference={reference}
          data-portrait-style="anime"
          data-portrait-label={`${persona.name} · ${label} 1장 · ${target === "body" ? "인물 시트 참조 · 성공 시 이전 몸·의상 연결 교체" : "현재 기본 몸 참조 · 옷과 장식만 제작"}`}
        >
          {label} {image ? "다시 생성" : "생성"}
        </button>
        {image && (
          <>
            <button
              type="submit"
              name="intent"
              value="rig-layers"
              formAction={action}
              className="secondary"
              disabled={locked}
              data-portrait-operation={`rig-layers:${target}:${image.operationId}`}
              data-artwork-target={target}
              data-artwork-reference={image.imageUrl}
              data-portrait-style="anime"
              data-layerize-target="true"
              data-layerize-persona={persona.id}
              data-layerize-source={image.operationId}
              data-portrait-label={`${persona.name} · ${label} 레이어 분리 · 최대 17개 과금`}
            >
              {label} 레이어 {image.layers ? "다시 분리" : "분리"}
            </button>
            {image.layers && (
              <a
                href={`/personas/${persona.id}/artwork-layers?target=${target}`}
                target="_blank"
                rel="noreferrer"
              >
                {label} 레이어 {image.layers.layers.length}개 검수 ↗
              </a>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function RigArtworkPanel({
  persona,
  artwork,
  action,
  locked,
  sheet,
}: {
  persona: PersonaRecord;
  artwork: Draft["rigArtwork"];
  action: string;
  locked: boolean;
  sheet?: string | undefined;
}) {
  const image = artwork?.image;
  const ready = image?.kind === "body" && !!image.layers;
  return (
    <section
      className="rig-artwork-panel"
      id="rig-artwork-preview"
      data-rig-artwork
      aria-labelledby="rig-artwork-title"
    >
      <h2 id="rig-artwork-title">rig-c 몸·의상 제작</h2>
      <p className="hint">
        속옷 차림의 기본 몸을 먼저 만들고 분리·움직임을 검수한 뒤, 같은 자세에 맞춘 의상을 별도로
        제작합니다.
      </p>
      {sheet ? (
        <p className="hint">
          <a href={sheet} target="_blank" rel="noreferrer" data-artwork-reference>
            참조할 애니메 인물 시트 원본
          </a>
        </p>
      ) : (
        <p className="hint">기본 몸을 만들려면 애니메 인물 시트를 먼저 만들어 주세요.</p>
      )}
      {image && image.kind !== "body" && (
        <p className="hint">
          현재 이미지는 이전 착의 원화입니다. 속옷 차림의 기본 몸을 새로 생성해야 별도 의상을 제작할
          수 있습니다.
        </p>
      )}
      <AssetActions
        persona={persona}
        image={image}
        target="body"
        reference={sheet}
        action={action}
        locked={locked}
      />
      <AssetActions
        persona={persona}
        image={image?.outfit}
        target="outfit"
        reference={ready ? image.imageUrl : undefined}
        action={action}
        locked={locked}
      />
      {!ready && (
        <p className="hint">기본 몸 레이어를 분리하고 움직임을 검수한 뒤 의상 생성을 선택하세요.</p>
      )}
      {image?.layers && (
        <a
          className="rig-test-link"
          href={`/personas/${persona.id}/rig-test`}
          target="_blank"
          rel="noreferrer"
        >
          분리 레이어로 움직임 테스트 ↗
        </a>
      )}
      {ready && (
        <section aria-label="얼굴 표정 생성">
          <h3>현재 얼굴 편집 · 몸 유지</h3>
          <p className="hint">
            현재 원화의 얼굴을 확대 참조해 한 장씩 편집합니다. 생성 결과는 비공개로 보관하고 부품
            추출·검수 후 적용합니다.
          </p>
          {[
            ["base", "얼굴 바탕 복원"],
            ["closed", "감긴 눈·미소"],
            ["surprised", "놀란 눈·벌린 입"],
          ].map(([kind, label]) => (
            <button
              key={kind}
              type="submit"
              name="intent"
              value="rig-artwork"
              formAction={action}
              disabled={locked}
              data-rig-artwork-target="true"
              data-artwork-target="body"
              data-rig-face-action={kind}
              data-portrait-operation={`rig-face:${kind}`}
              data-portrait-label={`${persona.name} · ${label} 1장 · 현재 얼굴 확대 참조 · 몸 유지`}
              data-artwork-reference={
                image.layers!.layers.find((layer) => layer.plane === "face")?.imageUrl ??
                image.imageUrl
              }
            >
              {label} 생성
            </button>
          ))}
        </section>
      )}
      <p className="hint">
        각 생성·분리마다 모델·가격·선택 프롬프트를 확인합니다. 한 번에 한 작업만 실행하며 실패하면
        이전 결과를 유지합니다. 둥근 숨은 관절 겹침·배경의 잔여 픽셀은 실제 굽힌 자세로 확인하세요.
      </p>
    </section>
  );
}
