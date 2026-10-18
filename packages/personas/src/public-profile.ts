import { Schema } from "effect";

const text = Schema.String.check(Schema.isPattern(/\S/));
export const isIdentityFact = (value: string) =>
  /^(?:나이|생년월일|age|birthDate|date of birth)(?:\s*[:：]|\s+\d|$)/i.test(value.trim());
export const basicProfileFields = [
  { key: "occupation", label: "직업" },
  { key: "location", label: "지역" },
] as const;
const Fact = Schema.Struct({
  key: Schema.optionalKey(Schema.Literals(["age", "occupation", "location"])),
  label: text,
  value: text,
});
const Section = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["basics", "lifestyle", "relationship"]),
    title: text,
    items: Schema.Array(Fact).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("interests"),
    title: text,
    items: Schema.Array(text).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ type: Schema.Literal("prompt"), question: text, answer: text }),
  Schema.Struct({ type: Schema.Literal("text"), title: text, body: text }),
]);

/** Public, plain-text data. Markdown syntax and private Persona fields never cross this interface. */
export const PublicProfile = Schema.Struct({ introduction: text, sections: Schema.Array(Section) });
export type PublicProfile = typeof PublicProfile.Type;
