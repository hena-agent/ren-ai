import { Schema } from "effect";
import { expect, test } from "vitest";
import { Activity, MetricsQuery } from "./metrics.ts";

test("anonymous activity accepts a bounded Source and rejects unknown steps and private fields", () => {
  const activity = {
    step: "visit",
    source: {
      entry: "home",
      referrer: "example.org",
      campaign: "launch",
      medium: "social",
      source: "friends",
    },
    device: "phone",
    locale: "ko",
    imageStyle: "anime",
  };
  const decode = Schema.decodeUnknownSync(Activity, { onExcessProperty: "error" });
  expect(decode(activity)).toEqual(activity);
  for (const extra of [
    { step: "message" },
    { step: "like" },
    { handle: "+821012345678" },
    { source: { ...activity.source, campaign: "x".repeat(81) } },
  ])
    expect(() => decode({ ...activity, ...extra })).toThrow(/step|handle|campaign|filter/);
  expect(decode({ ...activity, step: "like", persona: "sora" })).toMatchObject({ persona: "sora" });
});

test("Metrics date ranges use real calendar dates and bound a read to one year", () => {
  const decode = Schema.decodeUnknownSync(MetricsQuery);
  expect(decode({ from: "2026-10-01", to: "2026-10-27", breakdown: "source" })).toEqual({
    from: "2026-10-01",
    to: "2026-10-27",
    breakdown: "source",
  });
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-10-28", "2026-10-27"],
    ["2020-01-01", "2026-10-27"],
  ])
    expect(() => decode({ from, to })).toThrow(/Expected/);
});
