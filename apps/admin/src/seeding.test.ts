import { expect, test, vi } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { cloudflareFixture, adminBindings } from "../test/cloudflare-fixture.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { uploadSeeds, seedManifest, seedCharacter } from "../test/seeding.ts";
import { request, portraitReply } from "../test/fixtures.ts";
import { acceptedReview } from "../test/character.ts";
import { serializePersona } from "@ren-ai/personas";

test("an authenticated upload persists a reviewable run without authorizing any paid generation", async () => {
  const { db, bucket } = await cloudflareFixture();
  const { storage } = memoryStorage();
  const logs = captureWorkerLogs();
  const env = adminBindings(db, bucket);
  let admin = await cloudflareAdmin(env, storage);
  const response = await admin.fetch(uploadSeeds());
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  expect(location).toMatch(/^\/seeding\/[a-f0-9-]+$/);
  await admin.alarm();
  admin = await cloudflareAdmin(env, storage);
  const page = await (await admin.fetch(request(location))).text();
  expect(page).toContain("16 images");
  expect(page).toContain("Confirm paid run");
  expect((await admin.fetch(uploadSeeds())).headers.get("location")).toBe(location);
  expect(await (await admin.fetch(request("/api/personas"))).json()).toEqual([]);
  expect(logs.stdout.mock.calls.join(" ")).not.toContain("취업을 준비");
  logs.stdout.mockRestore();
  logs.stderr.mockRestore();
});

test("a confirmed run survives actor replacement, creates sheet-backed photos and publishes only reviewed selections", async () => {
  const { db, bucket, store } = await cloudflareFixture();
  const { storage } = memoryStorage();
  const logs = captureWorkerLogs();
  const provider = vi.fn<typeof fetch>();
  for (const seed of seedManifest().seeds) {
    provider.mockResolvedValueOnce(seedCharacter(seed));
    provider.mockResolvedValueOnce(acceptedReview());
    for (let i = 0; i < 4; i++) provider.mockResolvedValueOnce(await portraitReply());
  }
  vi.stubGlobal("fetch", provider);
  try {
    const env = { ...adminBindings(db, bucket), GEMINI_API_KEY: "private-seeding-key" };
    let admin = await cloudflareAdmin(env, storage);
    const location = (await admin.fetch(uploadSeeds())).headers.get("location")!;
    expect((await admin.fetch(request(location, { intent: "confirm", budget: "12" }))).status).toBe(
      303,
    );
    expect((await admin.fetch(request(location, { intent: "confirm", budget: "12" }))).status).toBe(
      303,
    );
    for (let i = 0; i < 60; i++) {
      await admin.alarm();
      admin = await cloudflareAdmin(env, storage);
    }
    const people = await store.list();
    expect(people).toHaveLength(4);
    expect(
      people.every(
        (person) => !person.published && person.portraits?.anime && person.portraits.photo,
      ),
    ).toBe(true);
    expect(provider).toHaveBeenCalledTimes(24);
    const requests = await Promise.all(
      provider.mock.calls.map((args) => new Request(...args).text()),
    );
    expect(requests[2]).toContain('"aspectRatio":"3:2"');
    expect(requests[4]).toContain('"aspectRatio":"4:5"');
    expect(requests[4]).toContain('"inlineData"');
    const reviewPage = await (await admin.fetch(request(location))).text();
    const selection = /name="persona" value="([^"]+)"/.exec(reviewPage)![1]!;
    const selected = people.find((person) => selection.startsWith(person.id))!;
    const initial = (await store.initial(selected.id))!;
    await store.save({ ...selected, openingLine: "Updated after review" }, initial, {
      persona: serializePersona(selected),
      initial,
    });
    await admin.fetch(request(`/personas/${selected.id}`));
    expect(
      (await admin.fetch(request(location, { intent: "publish", persona: selection }))).status,
    ).toBe(409);
    admin = await cloudflareAdmin(env, storage);
    await admin.fetch(request(`/personas/${selected.id}`));
    const refreshedPage = await (await admin.fetch(request(location))).text();
    const freshSelection = /name="persona" value="([^"]+)"/.exec(refreshedPage)![1]!;
    const published = await admin.fetch(
      request(location, { intent: "publish", persona: freshSelection }),
    );
    expect(published.status).toBe(303);
    const catalog = await (await admin.fetch(request("/api/personas"))).text();
    expect(catalog).toContain(selected.name);
    expect(catalog).not.toContain("Nemotron");
    expect(catalog).not.toContain("취업을 준비");
    await db.prepare("DELETE FROM personas WHERE id = ?").bind(selected.id).run();
    const afterDeletion = await (await admin.fetch(request(location))).text();
    expect(afterDeletion).not.toContain(`/personas/${selected.id}`);
    const changedRevision = { ...seedManifest(), revision: "b".repeat(40) };
    expect(
      (
        await admin.fetch(
          new Request(uploadSeeds(), { method: "POST", body: JSON.stringify(changedRevision) }),
        )
      ).status,
    ).toBe(409);
    expect((await admin.fetch(uploadSeeds())).headers.get("location")).toBe(location);
  } finally {
    vi.unstubAllGlobals();
    logs.stdout.mockRestore();
    logs.stderr.mockRestore();
  }
});
