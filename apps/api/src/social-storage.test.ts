import { Schema } from "effect";
import { expect, test } from "vitest";
import { SocialSnapshot } from "@ren-ai/onboarding/social";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { durableSocialFixture } from "../test/social-runtime.test-helper.ts";

test("real Durable Object SQLite preserves bounded history and uncertain sends across runtime replacement", async () => {
  const fixture = await durableSocialFixture();
  const request = fixture.request;
  try {
    expect(
      (
        await request("/management/social/accounts", {
          ...socialAccount,
          enabled: true,
          startHour: 0,
          endHour: 24,
        })
      ).status,
    ).toBe(200);
    const run = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
      await (await request("/__tick")).json(),
    );
    for (let step = 0; step < 60; step++)
      expect(
        (
          await request("/management/social/actions", {
            runId: run.runId,
            step,
            decision: { action: { kind: "search", query: `topic ${step}` }, reason: "Discovery" },
          })
        ).status,
      ).toBe(200);
    const send = {
      runId: run.runId,
      step: 60,
      decision: { action: { kind: "post", text: "A thought" }, reason: "Share" },
    };
    expect((await request("/management/social/actions", send)).status).toBe(503);
    await fixture.replace();
    expect((await request("/management/social/actions", send)).status).toBe(409);
    const snapshot = Schema.decodeUnknownSync(SocialSnapshot)(
      await (await request("/management/social")).json(),
    );
    expect(snapshot.events).toHaveLength(50);
    expect(snapshot.events[0]?.state).toBe("uncertain");
    const older = Schema.decodeUnknownSync(SocialSnapshot)(
      await (await request(`/management/social?before=${snapshot.before}`)).json(),
    );
    expect(older.events).toHaveLength(11);
    const proof = Schema.decodeUnknownSync(
      Schema.Struct({
        writes: Schema.Number,
        plans: Schema.Array(Schema.Struct({ detail: Schema.String })),
      }),
    )(await (await request("/__proof")).json());
    expect(proof.writes).toBe(1);
    expect(proof.plans.map((plan) => plan.detail).join(" ")).toContain("social_scope_events");
  } finally {
    await fixture.close();
  }
}, 30000);
