import type { IdentitySheets } from "@ren-ai/personas";
import copy from "./copy.json";

export function IdentitySheetPanel({
  sheets = {},
  action,
  locked,
}: {
  sheets?: IdentitySheets | undefined;
  action: string;
  locked: boolean;
}) {
  return (
    <section aria-labelledby="identity-sheets-title" className="identity-sheets">
      <div className="portrait-manager-heading">
        <h2 id="identity-sheets-title">다각도 인물 시트</h2>
        {!sheets.anime && !sheets.photo && (
          <button
            type="submit"
            name="intent"
            value="sheets"
            disabled={locked}
            formAction={action}
            data-portrait-operation="sheets"
            data-portrait-label="애니메·실사 인물 시트 각 1장 · 총 2장 생성"
          >
            두 스타일 시트 만들기
          </button>
        )}
      </div>
      <p className="hint">
        정면·반측면·측면으로 외모를 고정합니다. 완성 즉시 이후 사진의 기준이 되며 공개 갤러리에는
        포함되지 않습니다.
      </p>
      {(["anime", "photo"] as const).map((style) => (
        <div key={style} data-identity-sheet={style} id={`identity-sheet-${style}`}>
          <h3>{copy.portraitLabels[style]} 인물 시트</h3>
          <p className="hint" data-sheet-unavailable hidden>
            인물 시트를 읽을 수 없습니다. 기존 사진에서 시트를 다시 만들어 주세요.
          </p>
          {sheets[style] ? (
            <a href={sheets[style]} target="_blank" rel="noreferrer">
              <img
                className="identity-sheet-image"
                src={sheets[style]}
                alt={`${copy.portraitLabels[style]} 정면·반측면·측면 인물 시트`}
                width={1200}
                height={800}
              />
            </a>
          ) : (
            <p className="hint">
              시트를 먼저 만들면 이 스타일의 사진을 생성할 수 있습니다. 기존 사진을 기준으로 만들
              수도 있습니다.
            </p>
          )}
          <button
            type="submit"
            name="intent"
            value="sheet"
            className="secondary"
            disabled={locked}
            formAction={`${action}?style=${style}`}
            data-portrait-style={style}
            data-portrait-operation={`sheet:${style}:${sheets[style] ?? "new"}`}
            data-portrait-label={`${copy.portraitLabels[style]} 인물 시트 1장 생성`}
          >
            {sheets[style] ? "시트 다시 만들기" : "설명에서 시트 만들기"}
          </button>
        </div>
      ))}
    </section>
  );
}
