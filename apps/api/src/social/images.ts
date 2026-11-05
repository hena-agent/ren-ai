import { createHash, randomInt, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Schema } from "effect";
import type { SocialAccount, SocialRun } from "@ren-ai/onboarding/social";
import { SocialImage, type SocialImageData } from "@ren-ai/onboarding/social-images";
import { SocialError } from "./service.ts";
import type { SocialStore } from "./store.ts";
import { decodeImage, imageStore, type ImageRow } from "./image-store.ts";
import { imageQueue } from "./image-queue.ts";
import { socialFailureCause } from "@ren-ai/onboarding/social-diagnostics";

export interface SocialImagesBackend {
  generate: (input: {
    personaId: string;
    kind: SocialImage["kind"];
    style: SocialImage["style"];
    scene: string;
    beforeDispatch: () => Promise<void>;
  }) => Promise<Uint8Array>;
  put: (id: string, bytes: Uint8Array) => Promise<void>;
  get: (id: string) => Promise<Uint8Array | undefined>;
  remove: (id: string) => Promise<void>;
}
const owner = (row: ImageRow, account: SocialAccount, generation: number) =>
  row.account_id === account.id &&
  row.persona_id === account.personaId &&
  row.generation === generation;
function notSubmitted(error: Error, run: SocialRun, now: number) {
  return Object.assign(error, {
    diagnostic: {
      requestId: run.requestId,
      stage: "attachment" as const,
      submission: "not_attempted" as const,
      code: "SOCIAL_IMAGE_PREPARATION_FAILED",
      at: now,
      durationMs: 0,
      ...socialFailureCause(error),
    },
  });
}
function ideaFingerprint(style: "anime" | "photo", scene: string, creativeScene: string) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        style,
        scene.replace(/\s+/g, " ").trim(),
        creativeScene.replace(/\s+/g, " ").trim(),
      ]),
    )
    .digest("hex");
}
function expireReplacedGeneration(
  store: SocialStore,
  account: SocialAccount,
  generation: number,
  now: number,
) {
  store.exec(
    "UPDATE social_image SET state='expired',data=json_set(data,'$.state','expired'),due=? WHERE account_id=? AND generation<>? AND state IN ('queued','generating','ready','approved','publishing')",
    now,
    account.id,
    generation,
  );
}
function createIdea(
  store: SocialStore,
  images: ReturnType<typeof imageStore>,
  now: () => number,
  roll: () => number,
  run: SocialRun,
  account: SocialAccount,
  scene: string,
  probability: number,
  creativeScene: string,
  available: boolean,
) {
  return store.transaction(() => {
    const prior = store.exec<ImageRow>(
      "SELECT * FROM social_image WHERE run_id=? AND step=?",
      run.id,
      run.step,
    )[0];
    if (prior) return decodeImage(prior);
    const policy = account.images;
    if (!policy?.enabled || !available) throw new SocialError(409, "SOCIAL_IMAGES_DISABLED");
    const fingerprint = ideaFingerprint(policy.style, scene, creativeScene);
    const same = store.exec<ImageRow>(
      "SELECT * FROM social_image WHERE account_id=? AND generation=? AND fingerprint=?",
      account.id,
      run.generation,
      fingerprint,
    )[0];
    if (same) return decodeImage(same);
    expireReplacedGeneration(store, account, run.generation, now());
    if (
      store.exec<ImageRow>(
        "SELECT * FROM social_image WHERE account_id=? AND state IN ('queued','generating','ready','approved','publishing') LIMIT 1",
        account.id,
      )[0]
    )
      throw new SocialError(409, "SOCIAL_IMAGE_ALREADY_AVAILABLE");
    if (images.spent(account.id) >= policy.credits)
      throw new SocialError(409, "SOCIAL_IMAGE_BUDGET_EXHAUSTED");
    const chance = roll(),
      kindRoll = roll();
    const image: SocialImage = {
      id: randomUUID(),
      accountId: account.id,
      personaId: account.personaId,
      generation: run.generation,
      kind: kindRoll < 7500 ? "self" : "creation",
      style: policy.style,
      state: chance < probability ? "queued" : "skipped",
      probability,
      roll: chance,
      kindRoll,
      createdAt: now(),
    };
    store.exec(
      "INSERT INTO social_image(id,account_id,persona_id,generation,run_id,step,data,scene,fingerprint,state,due) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      image.id,
      account.id,
      account.personaId,
      run.generation,
      run.id,
      run.step,
      JSON.stringify(image),
      image.kind === "self" ? scene : creativeScene,
      fingerprint,
      image.state,
      image.state === "queued" ? now() : null,
    );
    return image;
  });
}
export function socialImages(
  store: SocialStore,
  now: () => number,
  backend: SocialImagesBackend | undefined,
  roll: () => number = () => randomInt(10000),
) {
  const images = imageStore(store);
  const rowFor = (id: string, account: SocialAccount, generation: number) => {
    const row = images.row(id);
    if (!row || !owner(row, account, generation)) throw new SocialError(409, "SOCIAL_IMAGE_SCOPE");
    return row;
  };
  const data = async (row: ImageRow): Promise<SocialImageData> => {
    if (!backend) throw new SocialError(503, "SOCIAL_IMAGES_UNAVAILABLE");
    const bytes = await backend.get(row.id);
    if (!bytes) throw new SocialError(409, "SOCIAL_IMAGE_MISSING");
    return { id: row.id, mime: "image/jpeg", data: Buffer.from(bytes).toString("base64") };
  };
  return {
    ...imageQueue(store, images, now, backend),
    latest: images.latest,
    snapshot: images.snapshot,
    operatorPreview: async (account: SocialAccount, generation: number, id: string) =>
      data(rowFor(id, account, generation)),
    idea: async (
      run: SocialRun,
      account: SocialAccount,
      scene: string,
      probability: number,
      creativeScene: string,
    ) => {
      if (run.contact !== null) throw new SocialError(409, "SOCIAL_IMAGE_PUBLIC_SCOPE_REQUIRED");
      const image = createIdea(
        store,
        images,
        now,
        roll,
        run,
        account,
        scene,
        probability,
        creativeScene,
        Boolean(backend),
      );
      if (image.state === "queued") await store.arm();
      return image;
    },
    preview: async (run: SocialRun, account: SocialAccount, id: string) => {
      if (run.contact !== null) throw new SocialError(409, "SOCIAL_IMAGE_PUBLIC_SCOPE_REQUIRED");
      const row = rowFor(id, account, run.generation);
      if (!["ready", "approved"].includes(row.state))
        throw new SocialError(409, "SOCIAL_IMAGE_NOT_READY");
      const image = await data(row);
      const active = store.run(run.id),
        current = store.account(account.id);
      if (
        !active ||
        active.state !== "running" ||
        store.decodeRun(active).contact !== null ||
        !current ||
        !owner(row, store.config(current), current.generation)
      )
        throw new SocialError(409, "SOCIAL_IMAGE_SCOPE_CHANGED");
      store.exec(
        "UPDATE social_image SET seen_run=? WHERE id=? AND state IN ('ready','approved')",
        run.id,
        id,
      );
      return image;
    },
    review: (run: SocialRun, account: SocialAccount, id: string, accept: boolean) => {
      rowFor(id, account, run.generation);
      if (run.contact !== null) throw new SocialError(409, "SOCIAL_IMAGE_REVIEW_REQUIRED");
      const state = accept ? ("approved" as const) : ("rejected" as const);
      const claimed = store.exec<{ data: string }>(
        "UPDATE social_image SET state=?,data=json_set(data,'$.state',?) WHERE id=? AND state='ready' AND seen_run=? AND account_id=? AND generation=? RETURNING data",
        state,
        state,
        id,
        run.id,
        account.id,
        run.generation,
      )[0];
      if (!claimed) throw new SocialError(409, "SOCIAL_IMAGE_REVIEW_REQUIRED");
      return Schema.decodeUnknownSync(Schema.fromJsonString(SocialImage))(claimed.data);
    },
    prepare: async (run: SocialRun, account: SocialAccount, id: string) => {
      try {
        const row = rowFor(id, account, run.generation);
        if (run.contact !== null || row.state !== "approved")
          throw new SocialError(409, "SOCIAL_IMAGE_REVIEW_REQUIRED");
        return await data(row);
      } catch (cause) {
        throw notSubmitted(
          cause instanceof Error ? cause : new Error("Social image preparation failed"),
          run,
          now(),
        );
      }
    },
    claim: (run: SocialRun, id: string) => {
      const current = store.run(run.id);
      if (!current || current.state !== "running")
        throw notSubmitted(new SocialError(409, "SOCIAL_RUN_STOPPED"), run, now());
      if (store.account(run.accountId)?.generation !== run.generation)
        throw notSubmitted(new SocialError(409, "SOCIAL_IMAGE_SCOPE_CHANGED"), run, now());
      const changed = store.exec(
        "UPDATE social_image SET state='publishing',data=json_set(data,'$.state','publishing'),seen_run=?,due=MAX(COALESCE(due,0),?) WHERE id=? AND state='approved' AND account_id=? AND generation=? RETURNING id",
        run.id,
        now() + 300000,
        id,
        run.accountId,
        run.generation,
      );
      if (!changed.length)
        throw notSubmitted(new SocialError(409, "SOCIAL_IMAGE_PUBLICATION_CONFLICT"), run, now());
    },
    settle: (run: SocialRun, id: string, state: "posted" | "uncertain" | "approved") => {
      const row = images.row(id);
      if (row?.seen_run === run.id && (row.state === state || row.state === "posted")) return;
      if (state === "approved" && row?.state !== "publishing") return;
      if (!row || row.state !== "publishing" || row.seen_run !== run.id)
        throw new SocialError(409, "SOCIAL_IMAGE_PUBLICATION_STALE");
      images.save(row, { ...decodeImage(row), state }, row.due);
    },
  };
}
export type SocialImages = ReturnType<typeof socialImages>;
