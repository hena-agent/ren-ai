import { Schema } from "effect";

const tag = Schema.String.check(Schema.isMaxLength(80), Schema.isPattern(/^[\p{L}\p{N} ._-]*$/u));
export const VisitSource = Schema.Struct({
  entry: Schema.Literals(["home", "about", "explore", "profile", "reselection"]),
  referrer: Schema.String.check(Schema.isMaxLength(253), Schema.isPattern(/^[a-zA-Z0-9.-]*$/)),
  source: tag,
  medium: tag,
  campaign: tag,
});
export type VisitSource = typeof VisitSource.Type;
export const BrowserStep = Schema.Literals([
  "visit",
  "explore",
  "profile_seen",
  "profile_opened",
  "like",
  "pass",
  "first_like",
  "join_opened",
]);
export const Activity = Schema.Struct({
  step: BrowserStep,
  source: VisitSource,
  device: Schema.Literals(["phone", "computer"]),
  locale: Schema.Literals(["ko", "en", "ja"]),
  imageStyle: Schema.Literals(["anime", "photo"]),
  visitCountry: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/))),
  persona: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
  ),
}).check(
  Schema.makeFilter(
    (value) =>
      !["profile_seen", "profile_opened", "like", "pass"].includes(value.step) ||
      value.persona !== undefined,
  ),
);
export type Activity = typeof Activity.Type;
export const MetricStep = Schema.Literals([
  ...BrowserStep.literals,
  "join",
  "join_failed",
  "selection",
  "greeting_sent",
  "greeting_failed",
  "greeting_uncertain",
  "first_reply",
  "active",
  "retention_1",
  "retention_7",
  "retention_30",
  "ending",
]);
export const MetricDimension = Schema.Literals([
  "total",
  "source",
  "country",
  "device",
  "locale",
  "imageStyle",
  "persona",
  "relationship",
  "language",
  "joining",
  "reason",
  "initiator",
]);
export const koreaDay = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);
const day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }),
);
export const MetricsQuery = Schema.Struct({
  from: day,
  to: day,
  breakdown: Schema.optionalKey(MetricDimension),
}).check(
  Schema.makeFilter(
    ({ from, to }) => from <= to && Date.parse(to) - Date.parse(from) < 366 * 86_400_000,
  ),
);
export type MetricsQuery = typeof MetricsQuery.Type;
export const MetricTotal = Schema.Struct({
  day,
  step: MetricStep,
  dimension: MetricDimension,
  value: Schema.String,
  count: Schema.Number,
});
export type MetricTotal = typeof MetricTotal.Type;
export const WebhookState = Schema.Literals(["unconfigured", "accepting", "rejected"]);
export const Metrics = Schema.Struct({
  from: day,
  to: day,
  previousFrom: day,
  previousTo: day,
  totals: Schema.Array(MetricTotal),
  previous: Schema.Array(MetricTotal),
  personas: Schema.Array(MetricTotal),
  previousPersonas: Schema.Array(MetricTotal),
  endings: Schema.Array(MetricTotal),
  previousEndings: Schema.Array(MetricTotal),
  cost: Schema.Array(Schema.Struct({ day, cost: Schema.Number, conversations: Schema.Number })),
  previousCost: Schema.Array(
    Schema.Struct({ day, cost: Schema.Number, conversations: Schema.Number }),
  ),
  alerts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      raisedAt: Schema.Number,
      detail: Schema.String,
      url: Schema.String,
    }),
  ),
  delivery: Schema.Struct({ alerts: WebhookState, reports: WebhookState, pending: Schema.Number }),
});
export type Metrics = typeof Metrics.Type;
