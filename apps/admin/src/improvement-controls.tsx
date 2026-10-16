import type { Draft } from "./draft.ts";

export function ImprovementControls({
  locked,
  input,
}: {
  locked: boolean;
  input?: Draft["improvementInput"];
}) {
  return (
    <dialog
      id="improvement-dialog"
      className="portrait-dialog"
      aria-labelledby="improvement-title"
      aria-describedby="improvement-hint"
    >
      <h2 id="improvement-title">페르소나 개선</h2>
      <p className="hint" id="improvement-hint">
        현재 초안에 바로 반영하고 변경된 부분을 표시합니다. 사진·State·Memory는 유지하며, 저장하기를
        눌러야 공개됩니다.
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
      <output data-improvement-pending aria-live="polite" />
      <div className="dialog-actions">
        <button type="button" className="secondary" data-close-document-dialog>
          취소
        </button>
        <button type="submit" name="intent" value="improve" disabled={locked}>
          개선하기
        </button>
      </div>
    </dialog>
  );
}
