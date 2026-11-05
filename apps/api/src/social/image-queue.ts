import type { SocialStore } from "./store.ts";
import { decodeImage, type imageStore, type ImageRow } from "./image-store.ts";
import type { SocialImagesBackend } from "./images.ts";
import { actionDiagnostic, recordActionFailure, saveSocialDiagnostic } from "./diagnostics.ts";
import type { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";
import { buildRevision } from "@ren-ai/transport/health";
import { SocialError } from "./service.ts";
import { codexImageModel } from "@ren-ai/image-generation";
import { contactLog } from "../discovery/diagnostics.ts";
const imageContext = (row: ImageRow) => ({
  personaId: row.persona_id,
  model: codexImageModel,
  style: decodeImage(row).style,
});

export function imageQueue(
  store: SocialStore,
  images: ReturnType<typeof imageStore>,
  now: () => number,
  backend: SocialImagesBackend | undefined,
) {
  const current = (row: ImageRow) => {
    const account = store.account(row.account_id);
    if (
      !account ||
      account.generation !== row.generation ||
      store.config(account).personaId !== row.persona_id
    )
      throw new SocialError(409, "SOCIAL_IMAGE_SCOPE_CHANGED");
    return store.config(account);
  };
  const permitted = (row: ImageRow) => {
    const config = current(row);
    if (!config.images?.enabled) throw new SocialError(409, "SOCIAL_IMAGES_DISABLED");
    return config;
  };
  const reconcileAttempt = async (row: ImageRow, storage: SocialImagesBackend) => {
    const image = decodeImage(row);
    if (
      row.state !== "generating" &&
      !(row.state === "uncertain" && image.diagnostic?.stage === "storage")
    ) {
      await storage.remove(row.id);
      images.save(row, { ...image, state: "expired" }, null);
      return;
    }
    // Recover saved output without repeating a paid call. A changed owner cannot adopt it.
    try {
      current(row);
    } catch {
      await storage.remove(row.id);
      images.save(row, { ...image, state: "expired" }, null);
      return;
    }
    const saved = await storage.get(row.id);
    current(row);
    if (saved) {
      images.save(row, { ...image, state: "ready" }, now() + 86400000);
      return;
    }
    const run = { ...store.decodeRun(store.run(row.run_id)!), step: row.step };
    const diagnostic: SocialDiagnostic = {
      requestId: run.requestId,
      stage: image.diagnostic?.stage ?? "generation",
      submission: "attempted",
      code: "SOCIAL_IMAGE_INTERRUPTED",
      at: now(),
      durationMs: image.diagnostic
        ? image.diagnostic.durationMs + Math.max(0, now() - image.diagnostic.at)
        : Math.max(0, now() - (row.due! - 150000)),
    };
    recordActionFailure(store, run, diagnostic, imageContext(row));
    images.save(row, { ...image, state: "uncertain", diagnostic }, null);
  };
  const reconcile = async (row: ImageRow, storage: SocialImagesBackend) => {
    try {
      await reconcileAttempt(row, storage);
    } catch (cause) {
      const image = decodeImage(row),
        run = { ...store.decodeRun(store.run(row.run_id)!), step: row.step };
      const diagnostic = { ...actionDiagnostic(cause, run, now()), stage: "storage" as const };
      recordActionFailure(store, run, diagnostic, imageContext(row));
      const storageFailures = Math.min(3, (image.storageFailures ?? 0) + 1);
      images.save(
        row,
        {
          ...image,
          state: row.state === "generating" ? "uncertain" : "expired",
          storageFailures,
          diagnostic,
        },
        storageFailures < 3 ? now() + 60000 * 2 ** storageFailures : null,
      );
    }
  };
  return {
    process: async () => {
      if (!backend) return;
      const row = store.exec<ImageRow>(
        "SELECT * FROM social_image WHERE due<=? AND (state<>'queued' OR NOT EXISTS(SELECT 1 FROM social_image WHERE state='generating')) ORDER BY due,rowid LIMIT 1",
        now(),
      )[0];
      if (!row) return;
      const image = decodeImage(row);
      if (row.state !== "queued") {
        await reconcile(row, backend);
        return;
      }
      let dispatched = false;
      let stage: "generation" | "storage" = "generation";
      const started = now();
      const run = { ...store.decodeRun(store.run(row.run_id)!), step: row.step };
      const fields = {
        requestId: run.requestId,
        operationId: row.id,
        operation: "social.image",
        ...imageContext(row),
      };
      contactLog({
        ...fields,
        stage: "generation",
        outcome: "started",
        durationMs: 0,
        level: "info",
      });
      const checkpoint = () => {
        const diagnostic: SocialDiagnostic = {
          requestId: run.requestId,
          stage,
          submission: dispatched ? "attempted" : "not_attempted",
          code: "SOCIAL_IN_PROGRESS",
          at: now(),
          durationMs: now() - started,
          revision: buildRevision(),
        };
        images.save(row, { ...image, state: "generating", diagnostic }, started + 150000);
        saveSocialDiagnostic(store, run.id, run.step, diagnostic);
      };
      images.save(row, { ...image, state: "generating" }, now() + 150000);
      await store.arm();
      try {
        permitted(row);
        checkpoint();
        const bytes = await backend.generate({
          personaId: row.persona_id,
          kind: image.kind,
          style: image.style,
          scene: row.scene,
          beforeDispatch: async () => {
            const config = permitted(row);
            if (!config.enabled) throw new SocialError(409, "SOCIAL_ACCOUNT_PAUSED");
            store.transaction(() => {
              if (images.spent(row.account_id) >= config.images!.credits)
                throw new SocialError(409, "SOCIAL_IMAGE_BUDGET_EXHAUSTED");
              if (images.globalSpent() >= images.globalApproved())
                throw new SocialError(409, "SOCIAL_IMAGE_GLOBAL_ALLOWANCE_EXHAUSTED");
              const claimed = store.exec(
                "UPDATE social_image SET paid=1 WHERE id=? AND paid=0 AND state='generating' RETURNING id",
                row.id,
              );
              if (!claimed.length) throw new SocialError(409, "SOCIAL_IMAGE_ALREADY_DISPATCHED");
              store.exec(
                "INSERT INTO social_image_budget VALUES (?,1) ON CONFLICT(account_id) DO UPDATE SET spent=spent+1",
                row.account_id,
              );
              store.exec("UPDATE social_image_global_budget SET spent=spent+1 WHERE id=1");
            });
            dispatched = true;
            checkpoint();
          },
        });
        current(row);
        stage = "storage";
        checkpoint();
        await backend.put(row.id, bytes);
        try {
          current(row);
        } catch (cause) {
          await backend.remove(row.id);
          throw cause;
        }
        images.save(row, { ...image, state: "ready" }, now() + 86400000);
        saveSocialDiagnostic(store, run.id, run.step, {
          requestId: run.requestId,
          stage: "storage",
          submission: "attempted",
          code: "SOCIAL_IMAGE_READY",
          at: now(),
          durationMs: now() - started,
          revision: buildRevision(),
        });
        contactLog({
          ...fields,
          stage: "storage",
          outcome: "completed",
          durationMs: now() - started,
          level: "info",
        });
      } catch (cause) {
        const diagnostic = {
          ...actionDiagnostic(
            cause,
            { ...store.decodeRun(store.run(row.run_id)!), step: row.step },
            now(),
          ),
          stage,
          submission: dispatched ? ("attempted" as const) : ("not_attempted" as const),
        };
        recordActionFailure(
          store,
          { ...store.decodeRun(store.run(row.run_id)!), step: row.step },
          diagnostic,
          imageContext(row),
        );
        images.save(
          row,
          { ...image, state: dispatched ? "uncertain" : "failed", diagnostic },
          stage === "storage" ? now() + 60000 : null,
        );
      }
    },
  };
}
