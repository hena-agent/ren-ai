import { expect, test } from "vitest";
import { Schema } from "effect";
import { SocialSnapshot } from "@ren-ai/onboarding/social";
import { socialImages } from "./social/images.ts";
import { socialStore } from "./social/store.ts";
import { imageStore, decodeImage } from "./social/image-store.ts";
import {
  socialImageTestContext,
  imageBackendFixture,
  imagePolicy,
} from "../test/social-image.test-helper.ts";
import { socialAccount } from "../test/social.test-helper.ts";

const context = socialImageTestContext();
async function readyImage() {
  const f = await context.queued();
  await f.app.alarm();
  const store = socialStore(f.storage);
  return {
    f,
    store,
    images: socialImages(store, f.options.now, f.api),
    run: f.runs[0]!,
    account: store.config(store.account("first")!),
  };
}

test.each(["missing_run", "stopped_run", "private_scope", "missing_account", "new_generation"])(
  "an asynchronous preview cannot mark an obsolete scope as reviewed: %s",
  async (mode) => {
    const { f, store, images, run, account } = await readyImage();
    const get = f.api.get;
    f.api.get = async (id) => {
      const data = await get(id);
      if (mode === "missing_run") f.db.prepare("DELETE FROM social_run WHERE id=?").run(run.id);
      else if (mode === "stopped_run")
        f.db.prepare("UPDATE social_run SET state='stopped' WHERE id=?").run(run.id);
      else if (mode === "private_scope")
        f.db
          .prepare("UPDATE social_run SET data=json_set(data,'$.contact','reader') WHERE id=?")
          .run(run.id);
      else if (mode === "missing_account")
        f.db.prepare("DELETE FROM social_account WHERE id='first'").run();
      else f.db.prepare("UPDATE social_account SET generation=generation+1 WHERE id='first'").run();
      return data;
    };
    await expect(images.preview(run, account, f.id)).rejects.toMatchObject({
      code: "SOCIAL_IMAGE_SCOPE_CHANGED",
    });
    expect(imageStore(store).row(f.id)?.seen_run).toBeNull();
  },
);

test.each(["missing", "changed"])(
  "a publication claim checks the current account after reading image bytes: %s",
  async (mode) => {
    const { f, store, images, run, account } = await readyImage();
    await images.preview(run, account, f.id);
    images.review(run, account, f.id, true);
    if (mode === "missing") f.db.prepare("DELETE FROM social_account WHERE id='first'").run();
    else f.db.prepare("UPDATE social_account SET generation=generation+1 WHERE id='first'").run();
    expect(() => images.claim(run, f.id)).toThrow("SOCIAL_IMAGE_SCOPE_CHANGED");
    expect(imageStore(store).row(f.id)?.state).toBe("approved");
  },
);

test("interrupted generation retains the originating request and last durable stage", async () => {
  const f = await context.queued(),
    store = socialStore(f.storage),
    saved = imageStore(store),
    row = saved.row(f.id)!,
    image = decodeImage(row);
  saved.save(
    row,
    {
      ...image,
      state: "generating",
      diagnostic: {
        requestId: f.runs[0]!.requestId,
        stage: "storage",
        submission: "attempted",
        code: "SOCIAL_IN_PROGRESS",
        at: f.options.now() - 500,
        durationMs: 100,
      },
    },
    f.options.now(),
  );
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]?.diagnostic).toMatchObject({
    requestId: f.runs[0]!.requestId,
    stage: "storage",
    durationMs: 600,
    code: "SOCIAL_IMAGE_INTERRUPTED",
  });
  expect(f.api.generate).not.toHaveBeenCalled();
});
test("scope, availability and pending-draft checks fail before a new dice draw or provider call", async () => {
  const f = await context.queued(),
    store = socialStore(f.storage),
    images = socialImages(store, f.options.now, f.api),
    run = f.runs[0]!,
    account = store.config(store.account("first")!);
  await expect(
    images.idea({ ...run, contact: "reader" }, account, "scene", 1000, "creation"),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGE_PUBLIC_SCOPE_REQUIRED" });
  await expect(
    images.idea({ ...run, step: 1 }, socialAccount, "scene", 1000, "creation"),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGES_DISABLED" });
  await expect(
    socialImages(store, f.options.now, undefined).idea(
      { ...run, step: 1 },
      account,
      "scene",
      1000,
      "creation",
    ),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGES_DISABLED" });
  await expect(
    images.idea({ ...run, step: 1 }, account, "other scene", 1000, "creation"),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGE_ALREADY_AVAILABLE" });
  await expect(images.preview(run, account, f.id)).rejects.toMatchObject({
    code: "SOCIAL_IMAGE_NOT_READY",
  });
  await expect(images.preview({ ...run, contact: "reader" }, account, f.id)).rejects.toMatchObject({
    code: "SOCIAL_IMAGE_PUBLIC_SCOPE_REQUIRED",
  });
  await expect(images.operatorPreview({ ...account, id: "other" }, 1, f.id)).rejects.toMatchObject({
    code: "SOCIAL_IMAGE_SCOPE",
  });
  await expect(
    images.operatorPreview({ ...account, personaId: "bob" }, 1, f.id),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGE_SCOPE" });
  await expect(images.operatorPreview(account, 2, f.id)).rejects.toMatchObject({
    code: "SOCIAL_IMAGE_SCOPE",
  });
  await expect(images.operatorPreview(account, 1, f.id)).rejects.toMatchObject({
    code: "SOCIAL_IMAGE_MISSING",
  });
  await expect(
    socialImages(store, f.options.now, undefined).operatorPreview(account, 1, f.id),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGES_UNAVAILABLE" });
  const empty = imageBackendFixture(),
    other = context.fixture({ images: empty.api });
  await other.enable({ images: { ...imagePolicy, credits: 0 } });
  const emptyStore = socialStore(other.storage);
  await socialImages(emptyStore, other.options.now, undefined).process();
  await expect(
    socialImages(emptyStore, other.options.now, empty.api).idea(
      other.runs[0]!,
      emptyStore.config(emptyStore.account("first")!),
      "scene",
      10000,
      "creation",
    ),
  ).rejects.toMatchObject({ code: "SOCIAL_IMAGE_BUDGET_EXHAUSTED" });
});

test("image store reports empty global and per-account allowance state without manufacturing paid calls", async () => {
  const f = context.fixture(),
    store = socialStore(f.storage),
    images = imageStore(store);
  expect(images.spent("missing")).toBe(0);
  expect(images.globalSpent()).toBe(0);
  expect(images.globalApproved()).toBe(0);
  expect((await f.snapshot()).imageAllowance).toEqual({ spent: 0, approved: 0 });
});
test("social snapshots omit the optional account allowance when no account is connected", async () => {
  const f = context.fixture(),
    snapshot = f.app.fetch(
      new Request("https://api.test/management/social", {
        headers: { Authorization: "Bearer secret" },
      }),
    );
  const response = await snapshot;
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(SocialSnapshot))(await response.text())
      .imageAllowance,
  ).toEqual({ spent: 0, approved: 0 });
});
test("review decisions and publication claims are fenced, single-use and idempotent", async () => {
  const { f, store, images, run, account } = await readyImage();
  expect(() => images.review({ ...run, contact: "reader" }, account, f.id, true)).toThrow(
    "SOCIAL_IMAGE_REVIEW_REQUIRED",
  );
  await expect(images.prepare({ ...run, contact: "reader" }, account, f.id)).rejects.toMatchObject({
    diagnostic: { submission: "not_attempted" },
  });
  await images.preview(run, account, f.id);
  images.review(run, account, f.id, false);
  expect(images.latest("first", 1)[0]?.state).toBe("rejected");
  expect(() => images.review(run, account, f.id, true)).toThrow("SOCIAL_IMAGE_REVIEW_REQUIRED");
  const saved = imageStore(store),
    row = saved.row(f.id)!;
  saved.save(row, { ...decodeImage(row), state: "approved" }, row.due);
  images.claim(run, f.id);
  expect(() => images.claim(run, f.id)).toThrow("SOCIAL_IMAGE_PUBLICATION_CONFLICT");
  expect(() => images.settle({ ...run, id: "other" }, f.id, "posted")).toThrow(
    "SOCIAL_IMAGE_PUBLICATION_STALE",
  );
  expect(() => images.settle(run, "missing", "posted")).toThrow("SOCIAL_IMAGE_PUBLICATION_STALE");
  images.settle(run, f.id, "approved");
  images.settle(run, f.id, "approved");
  images.claim(run, f.id);
  images.settle(run, f.id, "posted");
  images.settle(run, f.id, "uncertain");
  expect(images.latest("first", 1)[0]?.state).toBe("posted");
  expect(() => images.claim({ ...run, id: "missing" }, f.id)).toThrow("SOCIAL_RUN_STOPPED");
  f.db.prepare("UPDATE social_run SET state='failed' WHERE id=?").run(run.id);
  expect(() => images.claim(run, f.id)).toThrow("SOCIAL_RUN_STOPPED");
  const postedRow = imageStore(store).row(f.id)!;
  imageStore(store).save(postedRow, { ...decodeImage(postedRow), state: "expired" }, null);
  expect(() => images.settle(run, f.id, "posted")).toThrow("SOCIAL_IMAGE_PUBLICATION_STALE");
});
test("concurrent review submissions commit one explicit decision", async () => {
  const { f, images, run, account } = await readyImage();
  await images.preview(run, account, f.id);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => images.review(run, account, f.id, true)),
    Promise.resolve().then(() => images.review(run, account, f.id, false)),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(images.latest(account.id, run.generation)[0]?.state).toMatch(/^(approved|rejected)$/);
});
test("untrusted storage failures are normalized without carrying private strings into diagnostics", async () => {
  const f = await context.queued();
  await f.app.alarm();
  const store = socialStore(f.storage),
    saved = imageStore(store),
    row = saved.row(f.id)!;
  saved.save(row, { ...decodeImage(row), state: "approved" }, row.due);
  f.api.get = async () => {
    throw "PRIVATE_PAYLOAD";
  };
  await expect(
    socialImages(store, f.options.now, f.api).prepare(
      f.runs[0]!,
      store.config(store.account("first")!),
      f.id,
    ),
  ).rejects.toMatchObject({
    message: "Social image preparation failed",
    diagnostic: { stage: "attachment", submission: "not_attempted" },
  });
});
test.each(["paused", "disabled", "missing", "different_persona"])(
  "queued work checks live ownership and consent before dispatch: %s",
  async (mode) => {
    const f = await context.queued(),
      account = (await f.snapshot()).accounts[0]!.account;
    if (mode === "missing") f.db.prepare("DELETE FROM social_account WHERE id='first'").run();
    else
      f.db.prepare("UPDATE social_account SET config=? WHERE id='first'").run(
        JSON.stringify({
          ...account,
          ...(mode === "paused" && { enabled: false }),
          ...(mode === "disabled" && { images: { ...imagePolicy, enabled: false } }),
          ...(mode === "different_persona" && { personaId: "bob" }),
        }),
      );
    await f.app.alarm();
    expect((await f.snapshot()).images?.[0]).toMatchObject({
      state: "failed",
      diagnostic: { submission: "not_attempted" },
    });
    expect(f.objects.size).toBe(0);
  },
);
test("a paid dispatch receipt cannot be consumed twice", async () => {
  const f = await context.queued();
  f.api.generate = async (input) => {
    await input.beforeDispatch();
    await input.beforeDispatch();
    return new Uint8Array();
  };
  await f.app.alarm();
  expect((await f.snapshot()).accounts[0]!.imageSpent).toBe(1);
  expect((await f.snapshot()).images?.[0]).toMatchObject({
    state: "uncertain",
    diagnostic: { causeCode: "SOCIAL_IMAGE_ALREADY_DISPATCHED" },
  });
});
test("the cumulative allowance shared across accounts is enforced at provider dispatch", async () => {
  const f = await context.queued();
  f.db.prepare("UPDATE social_image_global_budget SET spent=4 WHERE id=1").run();
  f.db.prepare("INSERT INTO social_image_budget VALUES('first',0)").run();
  await f.app.alarm();
  expect((await f.snapshot()).imageAllowance).toEqual({ spent: 4, approved: 4 });
  expect((await f.snapshot()).images?.[0]).toMatchObject({
    state: "failed",
    diagnostic: { submission: "not_attempted" },
  });
  expect((await f.snapshot()).accounts[0]!.imageSpent).toBe(0);
  expect((await f.snapshot()).imageAllowance).toEqual({ spent: 4, approved: 4 });
  expect(f.objects.size).toBe(0);
});
test("storage recovery adopts a saved result without another paid call and cleans drafts whose owner changed", async () => {
  const f = await context.queued();
  let puts = 0;
  f.api.put = async (id, bytes) => {
    f.objects.set(id, bytes);
    puts++;
    throw new Error("put acknowledgement lost");
  };
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]).toMatchObject({
    state: "uncertain",
    diagnostic: { stage: "storage" },
  });
  f.advance(60001);
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]?.state).toBe("ready");
  expect(puts).toBe(1);
  expect(f.api.generate).toHaveBeenCalledOnce();
  const store = socialStore(f.storage),
    saved = imageStore(store),
    row = saved.row(f.id)!;
  saved.save(row, { ...decodeImage(row), state: "generating" }, f.options.now());
  f.db.prepare("UPDATE social_account SET generation=generation+1 WHERE id='first'").run();
  await f.app.alarm();
  expect((await f.snapshot()).images?.[0]?.state).toBe("expired");
  expect(f.objects.size).toBe(0);
});
test.each(["generating", "ready"] as const)(
  "failed storage maintenance is recorded and stops after three bounded retries: %s",
  async (state) => {
    const f = await context.queued(),
      store = socialStore(f.storage),
      saved = imageStore(store),
      row = saved.row(f.id)!;
    saved.save(row, { ...decodeImage(row), state }, f.options.now());
    f.api.get = async () => {
      throw new Error("R2 unavailable");
    };
    f.api.remove = async () => {
      throw new Error("R2 unavailable");
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.app.alarm();
      expect((await f.snapshot()).images?.[0]?.storageFailures).toBe(attempt);
      f.advance(60000 * 2 ** attempt + 1);
    }
    expect(saved.row(f.id)?.due).toBeNull();
    expect((await f.snapshot()).images?.[0]?.diagnostic?.stage).toBe("storage");
  },
);
