import copy from "./copy.json";

export function ImageOptions({
  prompt,
  operation,
  count,
  prompts,
}: {
  prompt?: string | undefined;
  operation?: string | undefined;
  count?: number | undefined;
  prompts?: readonly string[] | undefined;
}) {
  return (
    <dialog
      className="portrait-dialog"
      data-portrait-dialog
      aria-labelledby="portrait-dialog-title"
      aria-describedby="portrait-instructions-hint"
    >
      <h2 id="portrait-dialog-title">{copy.portraitDialogTitle}</h2>
      <p className="hint" data-portrait-target />
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
