import { Schema } from "effect";
import { isPhoneHandle } from "./countries.ts";

export const Email = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/)),
  Schema.check(Schema.isLowercased(), Schema.isTrimmed()),
);

const Phone = Schema.String.pipe(Schema.refine((value): value is string => isPhoneHandle(value)));

export const Handle = Schema.Union([Phone, Email]);
