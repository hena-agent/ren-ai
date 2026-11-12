import copy from "./copy.json";
import type { RigArtworkModel } from "./rig-artwork-models.ts";

export function ImageOptions({
  prompt,
  operation,
  count,
  prompts,
  artworkModel,
}: {
  prompt?: string | undefined;
  operation?: string | undefined;
  count?: number | undefined;
  prompts?: readonly string[] | undefined;
  artworkModel?: RigArtworkModel | undefined;
}) {
  return (
    <dialog
      className="portrait-dialog"
      data-portrait-dialog
      aria-labelledby="portrait-dialog-title"
      aria-describedby="portrait-instructions-hint"
    >
      <div className="portrait-dialog-content">
        <h2 id="portrait-dialog-title">{copy.portraitDialogTitle}</h2>
        <p className="hint" data-portrait-target />
        <input type="hidden" name="rigArtworkTarget" value="body" data-rig-target-input />
        <div data-image-count-options>
          <label htmlFor="image-count">{copy.imageCountLabel}</label>
          <select id="image-count" name="imageCount" defaultValue={count ?? 1}>
            {[1, 2, 3, 4, 5, 6].map((value) => (
              <option key={value} value={value}>
                {value}
                {copy.imageCountUnit}
              </option>
            ))}
          </select>
          <p className="hint" data-image-total aria-live="polite">
            {copy.imageCountHint}
          </p>
        </div>
        <div data-rig-model-options hidden>
          <div className="model-search-row">
            <label className="model-search-field" htmlFor="image-model-search">
              <span>모델 검색</span>
              <input
                id="image-model-search"
                type="search"
                data-model-search
                placeholder="모델명 또는 공급자 검색"
                autoComplete="off"
              />
            </label>
            <label className="model-provider-field" htmlFor="image-provider-filter">
              <span>공급자</span>
              <select id="image-provider-filter" data-model-provider defaultValue="connected">
                <option value="connected">연결된 공급자</option>
                <option value="">모든 공급자</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary model-refresh"
              data-model-refresh
              aria-label="모델 목록 새로고침"
              title="모델 목록 새로고침"
            >
              ↻
            </button>
          </div>
          <input
            type="hidden"
            name="rigArtworkModel"
            defaultValue=""
            data-initial-model={artworkModel ?? ""}
            disabled
          />
          <input type="hidden" name="rigArtworkQuote" value="" />
          <fieldset className="model-choices">
            <legend>원화 이미지 모델</legend>
            <div className="model-list" data-model-list aria-busy="false" />
          </fieldset>
          <div className="model-list-footer">
            <output className="hint" data-model-status aria-live="polite" />
            <button type="button" className="secondary" data-model-more hidden>
              더 보기
            </button>
          </div>
          <p className="hint" data-model-errors hidden role="alert" />
          <p className="model-price" data-model-price>
            모델을 선택하면 단가를 확인합니다.
          </p>
          <details className="model-details">
            <summary>생성 규격·과금 안내</summary>
            <p className="hint">
              기본 몸은 애니메 시트 원본, 의상은 현재 기본 몸을 참조해 한 장씩 생성합니다. 크기는
              모델별 지원 규격을 사용합니다. 표시 단가는 참고 정보이며 입력·출력·해상도에 따른 실제
              과금은 공급자 규칙을 따릅니다.
            </p>
          </details>
        </div>
        <div data-layerize-options hidden>
          <h3>Seedream 5 Pro · Layerize</h3>
          <input type="hidden" name="layerizeQuote" defaultValue="" disabled />
          <output className="hint" data-layerize-status aria-live="polite" />
          <p className="model-price" data-layerize-price />
          <p className="hint">
            원화는 유지하고 분리 결과를 별도로 저장합니다. 배경과 투명 PNG 레이어·위치·쌓임 순서를
            받아 검수합니다. 부품별 분리·가려진 부분 복원 품질은 결과에서 확인해야 합니다.
          </p>
        </div>
        <p className="hint" id="portrait-instructions-hint">
          {copy.portraitInstructionsHint}
        </p>
        <input type="hidden" name="separateImagePrompts" value="" data-separate-image-prompts />
        <div data-image-prompt-list>
          <div data-image-prompt-field>
            <label htmlFor="portrait-instructions">{copy.portraitInstructionsLabel}</label>
            <textarea
              id="portrait-instructions"
              name="portraitInstructions"
              rows={5}
              defaultValue={prompts?.[0] ?? prompt}
              data-portrait-operation={operation}
              placeholder={copy.portraitInstructionsPlaceholder}
              aria-describedby="portrait-instructions-hint"
            />
          </div>
          {prompts?.slice(1).map((value, index) => (
            <div data-image-prompt-field key={index}>
              <label htmlFor={`image-prompt-${index + 1}`}>
                {index + 2} · {copy.portraitInstructionsLabel}
              </label>
              <textarea
                id={`image-prompt-${index + 1}`}
                name="imagePrompts"
                rows={5}
                defaultValue={value}
                placeholder={copy.portraitInstructionsPlaceholder}
                aria-describedby="portrait-instructions-hint"
              />
            </div>
          ))}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="secondary" type="button" data-portrait-cancel>
          {copy.portraitDialogCancel}
        </button>
        <button type="button" data-portrait-confirm>
          {copy.portraitDialogConfirm}
        </button>
      </div>
    </dialog>
  );
}
