import { useCopy } from "./locale.tsx";
import { useState } from "react";
import { SelectField } from "./select-field.tsx";

export function ContactName({ disabled }: { disabled: boolean }) {
  const copy = useCopy();
  return (
    <div className="contact-fields">
      <label htmlFor="profile-name">
        <span className="field-requirement" aria-hidden="true">
          *
        </span>{" "}
        {copy.profileName}
      </label>
      <input
        id="profile-name"
        name="name"
        autoComplete="name"
        maxLength={100}
        required
        pattern=".*\S.*"
        title={copy.requiredName}
        placeholder={copy.profileNamePlaceholder}
        disabled={disabled}
      />
    </div>
  );
}

export function ContactProfile({ disabled }: { disabled: boolean }) {
  const copy = useCopy();
  const [gender, setGender] = useState("unset");
  return (
    <>
      <div className="contact-fields">
        <label htmlFor="profile-age">
          {copy.profileAge} <span className="field-requirement">{copy.profileOptional}</span>
        </label>
        <input
          id="profile-age"
          name="age"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          disabled={disabled}
        />
      </div>
      <div className="contact-fields">
        <label htmlFor="profile-gender">
          {copy.profileGender} <span className="field-requirement">{copy.profileOptional}</span>
        </label>
        <SelectField
          id="profile-gender"
          label={`${copy.profileGender} ${copy.profileOptional}`}
          className="form-language-select"
          value={gender}
          onValueChange={setGender}
          disabled={disabled}
          options={[
            { value: "unset", label: copy.genderUnset },
            { value: "female", label: copy.genderFemale },
            { value: "male", label: copy.genderMale },
            { value: "other", label: copy.genderOther },
          ]}
        />
        <input
          type="hidden"
          name="gender"
          value={gender === "unset" ? "" : gender}
          disabled={disabled}
        />
      </div>
    </>
  );
}
