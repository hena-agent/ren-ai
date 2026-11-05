import { expect, test } from "vitest";
import { Schema } from "effect";
import { SocialResult } from "@ren-ai/onboarding/social";
import { createSocial } from "./social/http.ts";
import { socialStore } from "./social/store.ts";
import { socialImages } from "./social/images.ts";
import { imageStore } from "./social/image-store.ts";
import { socialAccount } from "../test/social.test-helper.ts";

import {
  socialImageTestContext,
  imageBackendFixture as backend,
  imagePolicy as policy,
  approveImage,
} from "../test/social-image.test-helper.ts";
const context = socialImageTestContext();
const queued = context.queued;
test("rejecting a visually inspected draft records a separate non-publication decision", async () => {
  const f = await queued();
  await f.app.alarm();
  await f.request("/image", { runId: f.started[0], imageId: f.id });
  const result = Schema.decodeUnknownSync(SocialResult)(
    await (await f.action(1, { kind: "review_image", imageId: f.id, accept: false })).json(),
  );
  expect(result.text).toBe("Image rejected; not published.");
  expect(result.image?.state).toBe("rejected");
  expect(f.writes).toHaveLength(0);
});
test.each(["pre_submit", "unknown", "missing_receipt"])(
  "image publication preserves the outcome after %s failure and never replays it",
  async (mode) => {
    const f = await queued();
    await approveImage(f);
    let calls = 0;
    f.options.browser = async () => {
      calls++;
      if (mode === "missing_receipt") return { text: "unverified" };
      throw Object.assign(
        new Error("private browser error"),
        mode === "pre_submit"
          ? {
              diagnostic: {
                requestId: "request",
                stage: "attachment",
                submission: "not_attempted",
                code: "UPLOAD_FAILED",
                at: 1,
                durationMs: 1,
              },
            }
          : {},
      );
    };
    const action = { kind: "post" as const, text: "caption", imageId: f.id };
    expect((await f.action(2, action)).status).toBe(503);
    expect((await f.snapshot()).images?.[0]?.state).toBe(
      mode === "pre_submit" ? "approved" : "uncertain",
    );
    expect((await f.action(2, action)).status).toBe(409);
    expect(calls).toBe(1);
  },
);
test("a verified image permalink checkpoint recovers a lost Mac response without replaying the post", async () => {
  const f = await queued();
  await approveImage(f);
  let sends = 0;
  f.options.browser = async (run, _account, _action) => {
    sends++;
    const progress = await f.request("/progress", {
      runId: run.id,
      step: 2,
      diagnostic: {
        requestId: "mac-request",
        stage: "receipt",
        submission: "verified",
        code: "SOCIAL_CONFIRMED",
        at: 1,
        durationMs: 25,
        postId: "123",
      },
    });
    expect(progress.status).toBe(204);
    throw Object.assign(new Error("gateway reply lost"), { upstreamStatus: 503 });
  };
  const action = { kind: "post" as const, text: "caption", imageId: f.id };
  expect((await f.action(2, action)).status).toBe(200);
  const event = (await f.snapshot()).events[0]!;
  expect(event).toMatchObject({
    state: "completed",
    url: `https://x.com/${socialAccount.handle}/status/123`,
    diagnostic: { stage: "receipt", submission: "verified", postId: "123", upstreamStatus: 503 },
  });
  expect((await f.snapshot()).images?.[0]?.state).toBe("posted");
  expect((await f.action(2, action)).status).toBe(200);
  expect(sends).toBe(1);
});
test("dice decisions survive replay without a second paid call, and generation does not imply review or publication", async () => {
  const f = await queued();
  const replay = await f.action(0, {
    kind: "image_idea",
    scene: "PRIVATE_SCENE",
    creativeScene: "PRIVATE_ART",
    probability: 10000,
  });
  expect(Schema.decodeUnknownSync(SocialResult)(await replay.json()).image?.id).toBe(f.id);
  expect(f.api.generate).not.toHaveBeenCalled();
  await f.app.alarm();
  expect(f.api.generate).toHaveBeenCalledOnce();
  expect((await f.snapshot()).images?.[0]?.state).toBe("ready");
  expect((await f.snapshot()).accounts[0]!.imageSpent).toBe(1);
  expect((await f.action(1, { kind: "post", text: "caption", imageId: f.id })).status).toBe(409);
  expect(f.writes).toHaveLength(0);
  expect(context.logs.join("")).not.toContain("PRIVATE_SCENE");
});
test("a model must receive the scoped preview before review, then choose posting separately", async () => {
  const f = await queued();
  await f.app.alarm();
  expect((await f.request("/image", { runId: f.runs[0]!.id, imageId: "other" })).status).toBe(409);
  expect((await f.request("/image", { runId: f.runs[0]!.id, imageId: f.id })).status).toBe(200);
  expect((await f.action(1, { kind: "review_image", imageId: f.id, accept: true })).status).toBe(
    200,
  );
  expect((await f.snapshot()).images?.[0]?.state).toBe("approved");
  f.options.browser = async (_run, _account, action) => {
    f.writes.push(action);
    return { text: "Published", url: "https://x.com/persona_x/status/123" };
  };
  expect(
    (await f.action(2, { kind: "post", text: "AI-created scene", imageId: f.id })).status,
  ).toBe(200);
  expect((await f.snapshot()).images?.[0]?.state).toBe("posted");
  expect(f.writes).toHaveLength(1);
});
test.each([0, 7499, 7500, 9999])(
  "the persisted kind roll %i selects the exact 75:25 boundary",
  async (kindRoll) => {
    const b = backend();
    const f = context.fixture({ images: b.api });
    await f.enable({ images: policy });
    const store = socialStore(f.storage);
    let calls = 0;
    const images = socialImages(store, f.options.now, b.api, () => (calls++ === 0 ? 0 : kindRoll));
    const image = await images.idea(
      f.runs[0]!,
      store.config(store.account("first")!),
      "scene",
      10000,
      "creation",
    );
    expect(image.kind).toBe(kindRoll < 7500 ? "self" : "creation");
    expect(imageStore(store).row(image.id)?.scene).toBe(kindRoll < 7500 ? "scene" : "creation");
    expect(
      await images.idea(
        f.runs[0]!,
        store.config(store.account("first")!),
        "scene",
        10000,
        "creation",
      ),
    ).toEqual(image);
    expect(calls).toBe(2);
  },
);
test("a zero-probability idea creates a durable skipped receipt without spending or invoking the provider", async () => {
  const b = backend();
  const f = context.fixture({ images: b.api });
  await f.enable({ images: policy });
  await f.action(0, {
    kind: "image_idea",
    scene: "scene",
    creativeScene: "creation",
    probability: 0,
  });
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]?.state).toBe("skipped");
  expect((await f.snapshot()).accounts[0]!.imageSpent).toBe(0);
  expect(b.api.generate).not.toHaveBeenCalled();
});
test("an uncertain paid call survives actor replacement and is never retried automatically", async () => {
  const f = await queued();
  f.api.generate = async (input) => {
    await input.beforeDispatch();
    throw Object.assign(new Error("PRIVATE_PROVIDER_INPUT"), { code: "PROVIDER_FAILED" });
  };
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]).toMatchObject({
    state: "uncertain",
    diagnostic: { stage: "generation", submission: "attempted" },
  });
  const replacement = createSocial(f.storage, f.options);
  await replacement.alarm();
  expect((await f.snapshot()).accounts[0]!.imageSpent).toBe(1);
  expect(context.logs.join("")).not.toContain("PRIVATE_PROVIDER_INPUT");
});
test("a lost actor reconciles an existing saved object, or records an interrupted paid call without repeating it", async () => {
  const f = await queued();
  const store = socialStore(f.storage),
    images = imageStore(store);
  const row = images.row(f.id)!;
  images.save(
    row,
    {
      ...Schema.decodeUnknownSync(SocialResult)(
        await (
          await f.action(0, {
            kind: "image_idea",
            scene: "PRIVATE_SCENE",
            creativeScene: "PRIVATE_ART",
            probability: 10000,
          })
        ).json(),
      ).image!,
      state: "generating",
    },
    f.options.now(),
  );
  await createSocial(f.storage, f.options).alarm();
  expect((await f.snapshot()).images?.[0]?.state).toBe("uncertain");
  expect(f.api.generate).not.toHaveBeenCalled();
});

test("identical ideas at a later step reuse their original dice instead of buying another image", async () => {
  const f = await queued();
  const before = (await f.snapshot()).images![0]!;
  const second = Schema.decodeUnknownSync(SocialResult)(
    await (
      await f.action(1, {
        kind: "image_idea",
        scene: " PRIVATE_SCENE ",
        creativeScene: "PRIVATE_ART",
        probability: 1,
      })
    ).json(),
  );
  expect(second.image).toEqual(before);
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM social_image").get()?.["count"]).toBe(1);
  await f.app.alarm();
  expect(f.api.generate).toHaveBeenCalledOnce();
});
test("scoped previews are authenticated and review without receiving the image fails before publication", async () => {
  const f = await queued();
  await f.app.alarm();
  const unauthorized = await f.app.fetch(
    new Request("https://api.test/management/social/image-preview", {
      method: "POST",
      body: JSON.stringify({ accountId: "first", imageId: f.id }),
    }),
  );
  expect(unauthorized.status).toBe(401);
  expect((await f.request("/image-preview", { accountId: "missing", imageId: f.id })).status).toBe(
    404,
  );
  expect((await f.request("/image-preview", { accountId: "first", imageId: f.id })).status).toBe(
    200,
  );
  expect((await f.action(1, { kind: "review_image", imageId: f.id, accept: true })).status).toBe(
    409,
  );
  expect((await f.snapshot()).images?.[0]?.state).toBe("ready");
});
test("a cumulative paid allowance is rechecked at dispatch and is not a daily generation target", async () => {
  const f = await queued();
  const account = (await f.snapshot()).accounts[0]!.account;
  f.db
    .prepare("UPDATE social_account SET config=? WHERE id=?")
    .run(JSON.stringify({ ...account, images: { ...policy, credits: 0 } }), account.id);
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]).toMatchObject({
    state: "failed",
    diagnostic: { submission: "not_attempted", causeCode: "SOCIAL_IMAGE_BUDGET_EXHAUSTED" },
  });
  expect((await f.snapshot()).accounts[0]!.imageSpent).toBe(0);
  expect(f.objects.size).toBe(0);
});
test("approved operator allowances aggregate into the durable global cumulative ceiling", async () => {
  const b = backend(),
    f = context.fixture({ images: b.api });
  await f.enable({ images: { ...policy, credits: 3 } });
  await f.request("/accounts", {
    ...socialAccount,
    id: "second",
    personaId: "bob",
    enabled: false,
    images: { ...policy, credits: 2 },
  });
  await f.snapshot();
  expect(
    f.db
      .prepare(
        "SELECT COALESCE(SUM(json_extract(config,'$.images.credits')),0) AS approved FROM social_account WHERE json_extract(config,'$.images.enabled')=1",
      )
      .get()?.["approved"],
  ).toBe(3);
  expect((await f.snapshot()).imageAllowance).toEqual({ spent: 0, approved: 3 });
  expect(
    (await f.snapshot()).accounts.find((row) => row.account.id === "second")?.imageSpent ?? 0,
  ).toBe(0);
});
test.each(["generation", "storage"])(
  "ownership changes during %s cannot publish or retain an image for the replacement scope",
  async (stage) => {
    const f = await queued();
    const change = () =>
      f.db.prepare("UPDATE social_account SET generation=generation+1 WHERE id='first'").run();
    if (stage === "generation")
      f.api.generate = async (input) => {
        await input.beforeDispatch();
        change();
        return new Uint8Array([255, 216, 255, 217]);
      };
    else
      f.api.put = async (id, bytes) => {
        f.objects.set(id, bytes);
        change();
      };
    await f.app.alarm();
    expect((await f.snapshot()).images?.[0]?.state).toBe("uncertain");
    expect(f.objects.size).toBe(0);
    const store = socialStore(f.storage);
    expect(socialImages(store, f.options.now, f.api).latest("first", 2)).toEqual([]);
  },
);
test("saved output is recovered after actor replacement without repeating the paid call", async () => {
  const f = await queued(),
    store = socialStore(f.storage),
    images = imageStore(store),
    row = images.row(f.id)!;
  const image = (await f.snapshot()).images![0]!;
  images.save(row, { ...image, state: "generating" }, f.options.now());
  f.objects.set(f.id, new Uint8Array([255, 216, 255, 217]));
  await createSocial(f.storage, f.options).alarm();
  expect((await f.snapshot()).images?.[0]?.state).toBe("ready");
  expect(f.api.generate).not.toHaveBeenCalled();
});
test("expired drafts are cleaned with bounded work while idle reads do not write storage", async () => {
  const f = await queued();
  await f.app.alarm();
  f.advance(86400001);
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]?.state).toBe("expired");
  expect(f.objects.size).toBe(0);
  f.queries.length = 0;
  await f.snapshot();
  await f.snapshot();
  expect(f.queries.filter((query) => /^(INSERT|UPDATE|DELETE)/.test(query))).toEqual([]);
  expect(
    f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM social_image WHERE account_id=? AND generation=? ORDER BY rowid DESC LIMIT 6",
      )
      .all("first", 1)
      .some((row) => String(row["detail"]).includes("social_image_owner")),
  ).toBe(true);
});
