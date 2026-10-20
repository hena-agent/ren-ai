import { expect, test } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { cloudflareFixture, adminBindings, databasePersona } from "../test/cloudflare-fixture.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { seedManifest, uploadSeeds } from "../test/seeding.ts";
import { initialDocuments, request } from "../test/fixtures.ts";
import type { PersonaSeed } from "./seed-selection.ts";

test("seeding requires authentication, same-origin confirmation and bounded valid input without leaking source data", async () => {
  const { db, bucket } = await cloudflareFixture();
  const logs = captureWorkerLogs();
  const admin = await cloudflareAdmin(adminBindings(db, bucket), memoryStorage().storage);
  const upload = uploadSeeds();
  const headers = new Headers(upload.headers);
  headers.delete("authorization");
  expect((await admin.fetch(new Request(upload, { headers }))).status).toBe(401);
  headers.set("authorization", uploadSeeds().headers.get("authorization")!);
  headers.set("origin", "https://other.example");
  expect((await admin.fetch(new Request(uploadSeeds(), { headers }))).status).toBe(400);
  for (const body of [
    "{private-source",
    "null",
    JSON.stringify({ ...seedManifest(), revision: "invalid" }),
  ]) {
    expect((await admin.fetch(new Request(uploadSeeds(), { method: "POST", body }))).status).toBe(
      400,
    );
  }
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1_000_000));
      if (pulled === 10) controller.close();
    },
  });
  const streaming = { body: stream, duplex: "half" };
  expect((await admin.fetch(new Request(uploadSeeds(), streaming))).status).toBe(400);
  expect(pulled).toBeLessThan(9);
  const location = (await admin.fetch(uploadSeeds())).headers.get("location")!;
  expect(
    (
      await admin.fetch(
        new Request(uploadSeeds(), {
          method: "POST",
          body: JSON.stringify({ ...seedManifest(), revision: "b".repeat(40) }),
        }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await admin.fetch(
        new Request("http://localhost:3729/seeding", {
          method: "POST",
          headers: uploadSeeds().headers,
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await admin.fetch(
        new Request(request(location), {
          method: "POST",
          headers: uploadSeeds().headers,
          body: "not a form",
        }),
      )
    ).status,
  ).toBe(400);
  const form = new FormData();
  form.set("intent", "publish");
  form.set("persona", new Blob(["file"]), "persona.txt");
  const formHeaders = new Headers(uploadSeeds().headers);
  formHeaders.delete("content-type");
  expect(
    (
      await admin.fetch(
        new Request(request(location), { method: "POST", headers: formHeaders, body: form }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await admin.fetch(request(location, { intent: "retry", persona: "missing" }))).status,
  ).toBe(400);
  expect((await admin.fetch(request("/seeding/exclusions?cursor=bad"))).status).toBe(400);
  expect((await admin.fetch(request("/seeding"))).status).toBe(200);
  const exclusions = await (await admin.fetch(request("/seeding/exclusions?cursor=seeds:"))).text();
  for (const seed of seedManifest().seeds) expect(exclusions).toContain(seed.uuid);
  expect((await admin.fetch(request("/seeding/missing"))).status).toBe(404);
  expect((await admin.fetch(request(`/seeding/${"a".repeat(36)}`))).status).toBe(404);
  for (const fields of [
    { intent: "bad" },
    { intent: "confirm", budget: "NaN" },
    { intent: "publish", persona: "missing" },
  ])
    expect((await admin.fetch(request(location, fields))).status).toBe(400);
  expect(logs.stderr.mock.calls.join(" ")).not.toContain("private-source");
  expect(logs.stderr.mock.calls.join(" ")).not.toContain("취업을 준비");
  logs.stdout.mockRestore();
  logs.stderr.mockRestore();
});

test("uploaded manifests cannot change the source identity, age, selection balance or unique source receipts", async () => {
  const { db, bucket, store } = await cloudflareFixture();
  const logs = captureWorkerLogs();
  const admin = await cloudflareAdmin(adminBindings(db, bucket), memoryStorage().storage);
  const manifest = seedManifest();
  const first = manifest.seeds[0]!;
  const changed = (patch: Partial<PersonaSeed>) => ({
    ...manifest,
    seeds: [{ ...first, ...patch }, ...manifest.seeds.slice(1)],
  });
  const bodies = [
    { ...manifest, date: "not-a-date" },
    { ...manifest, seeds: manifest.seeds.slice(0, 3) },
    changed({ uuid: "f".repeat(32) }),
    changed({ name: "박다른" }),
    changed({ birthDate: "2005-10-20" }),
    changed({ birthDate: "2006-02-30" }),
    changed({ source: { ...first.source, country: "unknown" } }),
    changed({ source: { ...first.source, sex: "남자" } }),
    changed({ source: { ...first.source, age: 21 } }),
    changed({ source: { ...first.source, marital_status: "기혼" } }),
    changed({ source: { ...first.source, extra: "x".repeat(24001) } }),
    { ...manifest, seeds: [first, first, ...manifest.seeds.slice(2)] },
    changed({ age: 25, birthDate: "2001-10-20", source: { ...first.source, age: 25 } }),
  ];
  for (const body of bodies)
    expect(
      (
        await admin.fetch(
          new Request(uploadSeeds(), { method: "POST", body: JSON.stringify(body) }),
        )
      ).status,
    ).toBe(400);
  await store.save({ ...databasePersona, name: first.name }, initialDocuments, { persona: "" });
  expect((await admin.fetch(uploadSeeds())).status).toBe(409);
  expect(await (await admin.fetch(request("/seeding/exclusions"))).json()).toMatchObject({
    names: [first.name],
    records: [],
  });
  logs.stdout.mockRestore();
  logs.stderr.mockRestore();
});
