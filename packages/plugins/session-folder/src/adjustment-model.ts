import { Schema } from "effect";

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const markdown = Schema.String.check(Schema.isMaxLength(6000));
export const adjustmentState = Schema.Struct({
  reviewedAt: count,
  observed: count,
  reviewed: count,
  seen: Schema.Record(Schema.String, Schema.String),
  review: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      sessionID: Schema.String,
      expiresAt: count,
      through: count,
      fingerprint: Schema.String,
    }),
  ),
  history: Schema.Array(
    Schema.Struct({ at: count, before: markdown, after: markdown, reason: Schema.String }),
  ),
  receipts: Schema.Record(
    Schema.String,
    Schema.Struct({ inputHash: Schema.String, output: Schema.String }),
  ),
});
export const adjustmentSnapshot = Schema.Struct({ markdown, state: adjustmentState });
export const emptyAdjustments = (): typeof adjustmentSnapshot.Type => ({
  markdown: "",
  state: { reviewedAt: 0, observed: 0, reviewed: 0, seen: {}, history: [], receipts: {} },
});

export const adjustmentTool = {
  description:
    "Complete an occasional internal review of your conversation methods when <adjustment-review> is present. Review recent exchanges and existing ADJUSTMENTS.md: preserve personality, distinctive voice and values while improving natural reciprocity and sustained conversation. Replace the concise adjustments document, or use markdown: null when evidence does not justify a change. Remove ineffective or redundant adjustments. Silence alone is not failure; do not maximize message count, force questions or ignore goodbyes. Markdown and reason are persona-wide: never include user identities, private facts, quotations or relationship-specific preferences. Never change Ground rules, tool permissions or Persona identity. Use the provided reviewID; this tool sends no message.",
  input: Schema.Struct({
    reviewID: Schema.String,
    markdown: Schema.NullOr(markdown),
    reason: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(1000)),
  }),
};
