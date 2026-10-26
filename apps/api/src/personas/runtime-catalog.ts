import { Schema } from "effect";
import { imageFilenamePattern } from "@ren-ai/personas/image-url";
import { decodePersona } from "@ren-ai/personas";

const Reference = Schema.String.check(Schema.isPattern(imageFilenamePattern));
export const RuntimeSheets = Schema.Struct({
  anime: Schema.optional(Reference),
  photo: Schema.optional(Reference),
});

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: persisted private Catalog JSON
export function decodeRuntimePersona(input: unknown) {
  const { sheets: references, ...record } = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Unknown),
  )(input);
  const sheets = Schema.decodeUnknownSync(Schema.UndefinedOr(RuntimeSheets))(references);
  return { ...decodePersona(record), ...(sheets && { sheets }) };
}
