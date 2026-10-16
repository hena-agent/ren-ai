import type { Draft } from "./draft.ts";

export function ImprovementControls({
  locked,
  input,
  result,
}: {
  locked: boolean;
  input?: Draft["improvementInput"];
  result?: Draft["conversion"];
}) {
  return (
    <section className="improvement-controls" aria-label="페르소나 개선">
      <h3>페르소나 개선</h3>
      <p className="hint">
        현재 편집본을 기준으로 개선합니다. 결과를 확인하고 적용한 뒤 저장하세요. 사진·State·Memory는
        유지합니다.
      </p>
      <label htmlFor="improvement-scope">
        개선 범위
        <select
          id="improvement-scope"
          name="improvementScope"
          defaultValue={input?.scope ?? "persona"}
          disabled={locked}
        >
          <option value="persona">전체 Persona</option>
          <option value="profile">공개 프로필만</option>
        </select>
      </label>
      <label htmlFor="improvement-instructions">
        개선 요청 · 선택
        <textarea
          id="improvement-instructions"
          name="improvementInstructions"
          rows={2}
          maxLength={4000}
          defaultValue={input?.instructions}
          readOnly={locked}
          placeholder="말투는 유지하고, 관심사와 주말 생활을 구체적으로 보강해 줘."
        />
      </label>
      <button type="submit" name="intent" value="improve" disabled={locked}>
        페르소나 개선
      </button>
      {result && (
        <section className="improvement-result" aria-label="개선 결과 비교">
          <h3>변경 내용 확인</h3>
          <ul>
            {result.additions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <div className="improvement-comparison">
            <label htmlFor="improvement-before">
              변경 전<textarea id="improvement-before" readOnly rows={10} value={result.source} />
            </label>
            <label htmlFor="improvement-after">
              개선 제안
              <textarea id="improvement-after" readOnly rows={10} value={result.result} />
            </label>
          </div>
          <p className="hint">요청 이후 원문을 수정했다면 현재 원문으로 다시 개선하세요.</p>
          <div className="profile-item-actions">
            <button type="submit" name="intent" value="apply-improvement" disabled={locked}>
              편집 초안에 적용
            </button>
            <button type="submit" name="intent" value="discard-improvement" disabled={locked}>
              제안 취소
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
