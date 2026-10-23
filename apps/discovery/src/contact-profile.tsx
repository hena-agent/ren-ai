import { useCopy } from "./locale.tsx";

export function ContactProfile({ disabled }: { disabled: boolean }) {
  const copy = useCopy();
  return (
    <fieldset
      className="contact-profile contact-fields"
      disabled={disabled}
      aria-describedby="profile-hint"
    >
      <legend>{copy.profileFields}</legend>
      <p id="profile-hint" className="field-hint">
        {copy.profileHint}
      </p>
      <label htmlFor="profile-name">{copy.profileName}</label>
      <input
        id="profile-name"
        name="name"
        autoComplete="name"
        maxLength={100}
        required
        pattern=".*\S.*"
        title={copy.requiredName}
      />
      <label htmlFor="profile-age">{copy.profileAge}</label>
      <input id="profile-age" name="age" type="number" inputMode="numeric" min={1} step={1} />
      <label htmlFor="profile-gender">{copy.profileGender}</label>
      <select id="profile-gender" name="gender" defaultValue="">
        <option value="">{copy.genderUnset}</option>
        <option value="female">{copy.genderFemale}</option>
        <option value="male">{copy.genderMale}</option>
        <option value="other">{copy.genderOther}</option>
      </select>
    </fieldset>
  );
}
