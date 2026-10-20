import { expect, test } from "vitest";
import { durableSeedingFixture } from "../test/seeding-durable.ts";
import { seedManifest, uploadSeeds } from "../test/seeding.ts";
import { portraitReply, request, tokenOf } from "../test/fixtures.ts";

test("a complete seeding run pays for each output once across Durable Object replacement", async () => {
  const { store, db, call, location, step, expectCalls } = await durableSeedingFixture();
  expect(await store.list()).toHaveLength(4);
  await expectCalls(24);
  const { results } = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT personaId FROM seeding_seeds WHERE pending = 1 ORDER BY runId, ordinal LIMIT 1",
    )
    .all();
  expect(JSON.stringify(results)).toContain("USING INDEX seeding_pending");
  expect(JSON.stringify(results)).not.toContain("TEMP B-TREE");
  expect((await call(uploadSeeds())).headers.get("location")).toBe(location);
  for (let i = 0; i < 3; i++) await step();
  await expectCalls(24);
}, 30_000);

test("a failed paid image keeps completed outputs and retries only that image across Durable Object replacement", async () => {
  // The first seed's first photo fails after both identity sheets complete.
  const { store, call, location, evict, step, expectCalls } = await durableSeedingFixture({
    failedImage: 4,
  });
  expect(await store.list()).toHaveLength(4);
  await expectCalls(24);
  const page = await (await call(request(location))).text();
  expect(page).toContain("partial");
  const path = /href="(\/image-jobs\/[^"]+)"/.exec(page)![1]!;
  const jobPage = await (await call(request(path))).text();
  const person = (await store.list()).find(
    (entry) => entry.name === seedManifest().seeds[0]!.name,
  )!;
  const fields = { name: person.name, description: person.description! };
  await call(
    new Request("http://localhost:3729/test/script", {
      method: "POST",
      body: JSON.stringify([{ body: await (await portraitReply()).text(), status: 200 }]),
    }),
  );
  expect(
    (await call(request(`${path}/retry?image=0`, { ...fields, draft: tokenOf(jobPage) }))).status,
  ).toBe(303);
  await evict();
  await step();
  await expectCalls(25);
  const finished = await (await call(request(path))).text();
  expect(
    (
      await call(
        request(`/personas/${person.id}`, {
          ...fields,
          intent: "save",
          draft: tokenOf(finished),
        }),
      )
    ).status,
  ).toBe(303);
  expect((await store.get(person.id)).portraits).toHaveProperty("anime");
  expect((await store.get(person.id)).portraits).toHaveProperty("photo");
  const reviewed = await (await call(request(location))).text();
  expect(reviewed).not.toContain(">partial<");
  expect(reviewed).toContain(">done<");
}, 30_000);
