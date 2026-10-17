import type { D1Database, DurableObjectStorage } from "@cloudflare/workers-types";
import { createAdmin } from "./admin.ts";
import { databaseStore } from "./database-store.ts";
import { createProfileGenerator } from "./generation.ts";
import { loggedJob, operation, writeLog as workerLog } from "./logging.ts";
import { editingStorage } from "./editing-storage.ts";
import type { ImageBucket } from "./r2-images.ts";
import { managementClient } from "./contact-client.ts";
import { catalogDelivery, wakeAlarm } from "./catalog-delivery.ts";
import { recoverEditing, downloadEditingRecovery } from "./editing-recovery.ts";
import { restoreImageBatch } from "./image-batch.ts";

export interface AdminEnv {
  ADMIN_JURISDICTION?: "us" | "local";
  DB: D1Database;
  IMAGES: ImageBucket;
  ASSETS: { fetch: (url: string) => Promise<Pick<Response, "ok" | "text">> };
  ADMIN_PASSWORD: string;
  TOKEN_CATALOG: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_URL?: string;
  ADMIN_TEXT_MODEL?: string;
  ADMIN_IMAGE_MODEL?: string;
  APPLICATION_API_URL?: string;
  TOKEN_MANAGEMENT?: string;
}

export async function cloudflareAdmin(env: AdminEnv, storage: DurableObjectStorage) {
  const asset = async (name: string) => {
    const response = await env.ASSETS.fetch(`https://assets/${name}`);
    if (!response.ok) throw new Error("Admin static asset is unavailable");
    return response.text();
  };
  const editing = editingStorage(storage);
  const [loaded, css, editorCss, script] = await Promise.all([
    editing.load(),
    asset("style.css"),
    asset("editor.css"),
    asset("pending.js"),
  ]);
  const wake = () => wakeAlarm(storage, Date.now() + 1);
  const management = managementClient(env.APPLICATION_API_URL ?? "", env.TOKEN_MANAGEMENT ?? "");
  const delivery = catalogDelivery(storage, management.refreshCatalog);
  const localImages = env.ADMIN_JURISDICTION === "local";
  const store = databaseStore(env.DB, env.IMAGES, localImages ? "/images/" : undefined);
  const generator = createProfileGenerator({
    key: env.GEMINI_API_KEY ?? "",
    ...(env.GEMINI_API_URL && { endpoint: env.GEMINI_API_URL }),
    ...(env.ADMIN_TEXT_MODEL && { textModel: env.ADMIN_TEXT_MODEL }),
    ...(env.ADMIN_IMAGE_MODEL && { imageModel: env.ADMIN_IMAGE_MODEL }),
  });
  const saved = await loggedJob(
    crypto.randomUUID(),
    {},
    () =>
      operation("editing.restore", {}, () =>
        recoverEditing(storage, loaded, (batch) => restoreImageBatch(batch, generator, store)),
      ),
    workerLog,
    "/startup",
  );
  const handle = createAdmin(
    { ...store, save: (...args) => delivery.save(() => store.save(...args)) },
    env.ADMIN_PASSWORD,
    `${css}\n${editorCss}`,
    {
      script,
      localImages,
      log: workerLog,
      generator,
      persistence: {
        saved,
        checkpoint: editing.save,
        wake,
        recovery: () => downloadEditingRecovery(storage),
      },
      management,
      catalogPending: delivery.pending,
    },
  );
  return {
    fetch: handle,
    alarm: async () => {
      await delivery.flush();
      const job = handle.nextJob();
      if (!job) return;
      await loggedJob(
        job.requestId,
        { personaId: job.batch.personaId, jobId: job.id },
        handle.runNext,
        workerLog,
      );
      if (handle.nextJob()) await wake();
    },
  };
}
