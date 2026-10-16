import { Schema } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/mobile";
import { Email } from "./shapes.ts";

const isEmail = Schema.is(Email);
const normalizeEmail = (text: string) => {
  const email = text.trim().toLowerCase();
  return isEmail(email) ? email : undefined;
};

/** Narrow and normalize a Handle supplied by an operator: an email, or a mobile number written nationally for Korea or internationally. */
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrows untrusted operator HTTP input to a Handle
export const normalizeHandle = (input: unknown): string | undefined => {
  if (typeof input !== "string") return undefined;
  if (input.includes("@")) return normalizeEmail(input);
  const phone = parsePhoneNumberFromString(input, { defaultCountry: "KR", extract: false });
  return phone?.isValid() ? phone.number : undefined;
};
