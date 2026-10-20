import { vi } from "vitest";
import { cloudflareFixture, adminBindings } from "./cloudflare-fixture.ts";
import { cloudflareAdmin } from "../src/cloudflare-admin.ts";
import type { AdminEnv } from "../src/cloudflare-admin.ts";
import { memoryStorage } from "./memory-storage.ts";
import { captureWorkerLogs } from "./worker-logs.ts";
import { uploadSeeds, seedManifest, seedCharacter } from "./seeding.ts";
import { request, portraitReply } from "./fixtures.ts";
import { acceptedReview } from "./character.ts";

export async function seedingFixture(budget = "12", textModel?: string) {
  const fixture = await cloudflareFixture();
  const { storage, values } = memoryStorage();
  const logs = captureWorkerLogs();
  const provider = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("scripted provider unavailable"));
  vi.stubGlobal("fetch", provider);
  const env = {
    ...adminBindings(fixture.db, fixture.bucket),
    GEMINI_API_KEY: "private-seeding-key",
    ...(textModel && { ADMIN_TEXT_MODEL: textModel }),
  };
  const open = (overrides: Partial<AdminEnv> = {}) =>
    cloudflareAdmin({ ...env, ...overrides }, storage);
  const admin = await open();
  const location = (await admin.fetch(uploadSeeds())).headers.get("location")!;
  await admin.fetch(request(location, { intent: "confirm", budget }));
  return { ...fixture, storage, values, logs, provider, open, admin, location };
}

export async function scriptCompleteSeed(
  provider: Awaited<ReturnType<typeof seedingFixture>>["provider"],
) {
  provider
    .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
    .mockResolvedValueOnce(acceptedReview());
  for (let i = 0; i < 4; i++) provider.mockResolvedValueOnce(await portraitReply());
}

export async function completedSeed() {
  const fixture = await seedingFixture();
  await scriptCompleteSeed(fixture.provider);
  for (let i = 0; i < 12; i++) await fixture.admin.alarm();
  const person = (await fixture.store.list())[0]!;
  const page = await (await fixture.admin.fetch(request(fixture.location))).text();
  const selection = /name="persona" value="([^"]+)"/.exec(page)![1]!;
  return { ...fixture, person, selection };
}

export const markSaveFailed = (db: Awaited<ReturnType<typeof seedingFixture>>["db"], id: string) =>
  db
    .prepare("UPDATE seeding_seeds SET stage = 'failed', retryStage = 'save' WHERE personaId = ?")
    .bind(id)
    .run();
