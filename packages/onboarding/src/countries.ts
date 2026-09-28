/** A new market adds one entry; both normalization and the HTTP shape use it. */
export const countries = {
  KR: { dialCode: "82", local: /^(?:010\d{8}|02\d{7,8}|0[3-6][1-5]\d{7,8}|070\d{8})$/ },
} as const;

export type Country = keyof typeof countries;

export const isPhoneHandle = (value: string): boolean => {
  for (const { dialCode, local } of Object.values(countries)) {
    if (value.startsWith(`+${dialCode}`) && local.test(`0${value.slice(dialCode.length + 1)}`)) {
      return true;
    }
  }
  return false;
};
