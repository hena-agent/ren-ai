import { StartingRelationship } from "@ren-ai/onboarding";
import { useCopy } from "./locale.tsx";

export function RelationshipSelect({
  value,
  onChange,
  disabled,
}: {
  value: StartingRelationship;
  onChange: (value: StartingRelationship) => void;
  disabled: boolean;
}) {
  const copy = useCopy().startingRelationship;
  return (
    <fieldset className="relationship-select" disabled={disabled}>
      <legend>{copy.title}</legend>
      <p className="field-hint">{copy.hint}</p>
      <div className="relationship-options">
        {StartingRelationship.literals.map((mode) => (
          <label className="relationship-option" key={mode} aria-label={copy[mode].title}>
            <input
              type="radio"
              name="startingRelationship"
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
            />
            <span>
              <strong>{copy[mode].title}</strong>
              <small>{copy[mode].description}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
