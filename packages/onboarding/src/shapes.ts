import { Schema } from "effect";
import { parsePhoneNumberFromString } from "libphonenumber-js/mobile";

export const Email = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/)),
  Schema.check(Schema.isLowercased(), Schema.isTrimmed()),
);

const isMobileNumber = (value: string) => {
  const phone = parsePhoneNumberFromString(value, { extract: false });
  return phone?.number === value && phone.isValid();
};

/** A mobile number of any country in E.164 form: the only kind of Handle Discovery registers. */
export const MobileNumber = Schema.String.check(Schema.makeFilter(isMobileNumber));
