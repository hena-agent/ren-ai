import { Schema } from "effect";
import { countries } from "./countries.ts";
import type { Country } from "./countries.ts";
import { Email } from "./shapes.ts";

const isEmail = Schema.is(Email);
const normalizeEmail = (text: string) => {
  const email = text.trim().toLowerCase();
  return isEmail(email) ? email : undefined;
};

/** Narrow and normalize a Handle supplied by a browser (or an HTTP request). */
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrows untrusted form or HTTP input to a Handle
export const normalizeHandle = (input: unknown, country: Country = "KR"): string | undefined => {
  if (typeof input !== "string") return undefined;
  const text = input;
  if (text.includes("@")) return normalizeEmail(text);
  const digits = text.replace(/[ -]/g, "");
  const { dialCode, local } = countries[country];
  const localNumber = digits.startsWith(`+${dialCode}`)
    ? `0${digits.slice(dialCode.length + 1)}`
    : digits;
  if (!local.test(localNumber)) return undefined;
  const normalized = `+${dialCode}${localNumber.slice(1)}`;
  return normalized;
};
