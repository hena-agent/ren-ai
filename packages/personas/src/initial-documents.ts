import { Schema } from "effect";

export const InitialDocuments = Schema.Struct({
  state: Schema.String.check(Schema.isMaxLength(16000)),
  memory: Schema.String.check(Schema.isMaxLength(16000)),
});
export type InitialDocuments = typeof InitialDocuments.Type;
