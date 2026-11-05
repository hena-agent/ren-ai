import { Schema } from "effect";
import { expect, test, vi } from "vitest";
import { SocialSnapshot, SocialResult } from "@ren-ai/onboarding/social";
import { durableSocialFixture } from "../test/social-runtime.test-helper.ts";
import { socialAccount } from "../test/social.test-helper.ts";

test("real Durable Object image decisions, paid-call receipts and scoped previews survive actor replacement", async () => {
  const f = await durableSocialFixture();
  const snapshot = async () =>
    Schema.decodeUnknownSync(SocialSnapshot)(await (await f.request("/management/social")).json());
  try {
    await f.request("/management/social/accounts", {
      ...socialAccount,
      enabled: true,
      startHour: 0,
      endHour: 24,
      images: { enabled: true, credits: 2, style: "photo" },
    });
    const run = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
      await (await f.request("/__tick")).json(),
    );
    const action = {
      runId: run.runId,
      step: 0,
      decision: {
        action: {
          kind: "image_idea",
          scene: "private scene",
          creativeScene: "private art",
          probability: 10000,
        },
        reason: "visual self-expression",
      },
    };
    const result = Schema.decodeUnknownSync(SocialResult)(
      await (await f.request("/management/social/actions", action)).json(),
    );
    const id = result.image!.id;
    await f.request("/__tick");
    await vi.waitFor(async () => expect((await snapshot()).images?.[0]?.state).toBe("ready"), {
      timeout: 5000,
    });
    const original = (await snapshot()).images![0]!;
    await f.replace();
    expect(
      Schema.decodeUnknownSync(SocialResult)(
        await (await f.request("/management/social/actions", action)).json(),
      ).image?.id,
    ).toBe(id);
    expect((await snapshot()).images?.[0]).toEqual(original);
    expect((await snapshot()).accounts[0]?.imageSpent).toBe(1);
    expect((await snapshot()).imageAllowance).toEqual({ spent: 1, approved: 2 });
    expect(
      (
        await f.request("/management/social/image-preview", {
          accountId: socialAccount.id,
          imageId: id,
        })
      ).status,
    ).toBe(200);
    const proof = Schema.decodeUnknownSync(
      Schema.Struct({
        imageCalls: Schema.Number,
        imagePlans: Schema.Array(Schema.Struct({ detail: Schema.String })),
      }),
    )(await (await f.request("/__proof")).json());
    expect(proof.imageCalls).toBe(1);
    expect(proof.imagePlans.some((row) => row.detail.includes("social_image_due"))).toBe(true);
    expect(proof.imagePlans.some((row) => row.detail.includes("social_image_state"))).toBe(true);
    expect(proof.imagePlans.some((row) => /SCAN social_image|TEMP B-TREE/.test(row.detail))).toBe(
      false,
    );
  } finally {
    await f.close();
  }
}, 30000);
