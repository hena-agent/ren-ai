import { afterEach, expect, test, vi } from "vitest";
import { seedingFixture, scriptCompleteSeed } from "../test/seeding-failures.ts";
import { seedCharacter, seedManifest } from "../test/seeding.ts";
import { acceptedReview, characterResponse } from "../test/character.ts";
import { portraitReply, request } from "../test/fixtures.ts";
import { personaImages } from "@ren-ai/personas";

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each([seedManifest().seeds[0]!.uuid, seedManifest().revision, "Nemotron-Personas-Korea"])(
  "generated provenance is rejected before saving or paying for images (%s)",
  async (provenance) => {
    const { admin, provider, store, logs } = await seedingFixture();
    provider
      .mockResolvedValueOnce(
        seedCharacter(seedManifest().seeds[0]!, `# 현재 생활\n\n자료 출처: ${provenance}`),
      )
      .mockResolvedValueOnce(acceptedReview());
    await admin.alarm();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await store.list()).toEqual([]);
    expect(await new Request(...provider.mock.calls[0]!).text()).not.toContain(
      seedManifest().seeds[0]!.uuid,
    );
    expect(logs.stderr.mock.calls.join(" ")).toContain(
      "Generated documents contain private source provenance",
    );
  },
);

test("explicit overload rejections retry at most twice while uncertain calls stop and require individual confirmation", async () => {
  const { admin, provider, location, open } = await seedingFixture();
  for (let i = 0; i < 3; i++)
    provider.mockResolvedValueOnce(
      Response.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: 429 }),
    );
  await admin.alarm();
  expect(provider).toHaveBeenCalledTimes(3);
  const page = await (await admin.fetch(request(location))).text();
  expect(page).toContain("Confirm retry for 김하나");
  expect(page).toContain("failed at draft");
  const id = /name="persona" value="([a-f0-9-]{36})"/.exec(page)![1]!;
  const restarted = await open();
  expect((await restarted.fetch(request(location, { intent: "retry", persona: id }))).status).toBe(
    303,
  );
  provider
    .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
    .mockResolvedValueOnce(acceptedReview());
  await restarted.alarm();
  expect(provider).toHaveBeenCalledTimes(5);
  expect((await restarted.fetch(request(location, { intent: "retry", persona: id }))).status).toBe(
    400,
  );
});

test("uncertain upstream failures are not retried and safe diagnostics correlate with the confirmed run", async () => {
  const { admin, provider, location, logs } = await seedingFixture();
  provider.mockRejectedValue(new Error("transport disconnected private-seeding-key"));
  await admin.alarm();
  expect(provider).toHaveBeenCalledTimes(1);
  const page = await (await admin.fetch(request(location))).text();
  const diagnostics = logs.stderr.mock.calls.join(" ");
  expect(diagnostics).toContain("network_error");
  expect(diagnostics).toContain('"stage":"generation.api"');
  expect(diagnostics).not.toContain("private-seeding-key");
  expect(diagnostics).not.toContain("취업을 준비");
  expect(page).toContain("Request ID:");
});

test("a failed style preserves its sibling sheet and photo, saves unpublished and cannot be bulk published", async () => {
  const { admin, provider, location, store } = await seedingFixture();
  provider
    .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
    .mockResolvedValueOnce(acceptedReview())
    .mockRejectedValueOnce(new Error("uncertain anime sheet"))
    .mockResolvedValueOnce(await portraitReply())
    .mockResolvedValueOnce(await portraitReply());
  for (let i = 0; i < 10; i++) await admin.alarm();
  const people = await store.list();
  expect(people).toHaveLength(1);
  const person = people[0]!;
  expect(person.published).toBe(false);
  expect(typeof (await store.sheets(person.id)).photo).toBe("string");
  expect(personaImages(person).map((image) => image.style)).toEqual(["photo"]);
  const page = await (await admin.fetch(request(location))).text();
  const selection = /name="persona" value="([^"]+)"/.exec(page)![1]!;
  expect(
    (await admin.fetch(request(location, { intent: "publish", persona: selection }))).status,
  ).toBe(400);
});

test("the maximum budget survives replacement and rejects calls before dispatch, including image calls", async () => {
  const { provider, location, open, db, store } = await seedingFixture("1");
  await scriptCompleteSeed(provider);
  for (let i = 0; i < 20; i++) await (await open()).alarm();
  expect(
    provider.mock.calls.filter((args) => new Request(...args).url.includes("flash-image")),
  ).toHaveLength(1);
  const budget = await db
    .prepare("SELECT reservedMicros FROM seeding_runs")
    .first<{ reservedMicros: number }>();
  expect(budget!.reservedMicros).toBeLessThanOrEqual(1_000_000);
  expect((await store.list()).every((person) => !person.published)).toBe(true);
  expect(await (await (await open()).fetch(request(location))).text()).toContain("failed");
});

test("unpriced model overrides are blocked before paying and generated identity mismatches never reach image generation", async () => {
  const blocked = await seedingFixture();
  await (await blocked.open({ ADMIN_TEXT_MODEL: "custom-model" })).alarm();
  expect(blocked.provider).not.toHaveBeenCalled();
  const fixture = await seedingFixture();
  fixture.provider
    .mockResolvedValueOnce(characterResponse())
    .mockResolvedValueOnce(acceptedReview());
  await fixture.admin.alarm();
  expect(fixture.provider).toHaveBeenCalledTimes(2);
  expect(await fixture.store.list()).toEqual([]);
  expect(await (await fixture.admin.fetch(request(fixture.location))).text()).toContain(
    "failed at draft",
  );
  const unpriced = await seedingFixture("12", "unpriced-model");
  expect(await (await unpriced.admin.fetch(request(unpriced.location))).text()).toContain(
    "unpriced-model",
  );
  expect(
    (await unpriced.admin.fetch(request(unpriced.location, { intent: "confirm", budget: "12" })))
      .status,
  ).toBe(400);
});
