import { afterEach, expect, test, vi } from "vitest";
import { cloudflareAdmin } from "./cloudflare-admin.ts";
import { cloudflareFixture, adminBindings } from "../test/cloudflare-fixture.ts";
import { memoryStorage } from "../test/memory-storage.ts";
import { captureWorkerLogs } from "../test/worker-logs.ts";
import { seedManifest, usSeedManifest, seedCharacter, uploadSeeds } from "../test/seeding.ts";
import { request, png } from "../test/fixtures.ts";
import { acceptedReview } from "../test/character.ts";
import { parseCharacterDescription } from "@ren-ai/personas";
import { requirePublicProfile } from "@ren-ai/personas/profile";
import { Schema } from "effect";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each(["ko", "en"])(
  "%s Codex seeding preserves language, initial documents, references and unpublished saves across replacement",
  async (language) => {
    const { db, bucket, store } = await cloudflareFixture();
    const { storage } = memoryStorage();
    captureWorkerLogs();
    const manifest =
      language === "en"
        ? usSeedManifest()
        : { ...seedManifest(), seeds: seedManifest().seeds.slice(0, 1) };
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(seedCharacter(manifest.seeds[0]!))
      .mockResolvedValueOnce(acceptedReview());
    for (let i = 0; i < 4; i++)
      provider.mockImplementationOnce(async () =>
        Response.json({ data: [{ b64_json: png.toString("base64") }] }),
      );
    vi.stubGlobal("fetch", provider);
    const env = {
      ...adminBindings(db, bucket),
      GEMINI_API_KEY: "text-secret",
      ADMIN_IMAGE_PROVIDER: "codex",
      CODEX_IMAGE_API_KEY: "image-secret",
    };
    let admin = await cloudflareAdmin(env, storage);
    const location = (
      await admin.fetch(
        new Request(uploadSeeds(1), { method: "POST", body: JSON.stringify(manifest) }),
      )
    ).headers.get("location")!;
    expect((await admin.fetch(request(location, { intent: "confirm", budget: "3" }))).status).toBe(
      303,
    );
    for (let i = 0; i < 15; i++) {
      await admin.alarm();
      admin = await cloudflareAdmin(env, storage);
    }
    const [person] = await store.list();
    expect(person).toMatchObject({
      name: manifest.seeds[0]!.name,
      published: false,
      language,
      timeZone: language === "en" ? "America/New_York" : "Asia/Seoul",
    });
    expect(
      parseCharacterDescription(requirePublicProfile(person!.description!).privateMarkdown)
        .languageBackground,
    ).toEqual({ primary: language, native: manifest.seeds[0]!.locale?.native ?? ["ko"] });
    const initial = await store.initial(person!.id);
    expect(initial?.state).toContain("fluent");
    expect(initial?.memory).toContain("현재 생활");
    const sheets = await store.sheets(person!.id);
    for (const style of ["anime", "photo"] as const) {
      expect(sheets[style]).toBeTypeOf("string");
      expect(person!.portraits?.[style]).toBeTypeOf("string");
    }
    expect(provider).toHaveBeenCalledTimes(6);
    const calls = provider.mock.calls.map((args) => new Request(...args));
    expect(calls.slice(0, 2).every((call) => call.url.includes("gemini-3.8-flash"))).toBe(true);
    expect(
      calls.slice(2).every((call) => new URL(call.url).origin === "https://codex-image.renai.im"),
    ).toBe(true);
    expect(calls.slice(2).map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/images/generations",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/images/edits",
    ]);
    for (const call of calls.slice(4))
      expect(await call.json()).toMatchObject({
        model: "gpt-image-2.5",
        image: [`data:image/png;base64,${png.toString("base64")}`],
      });
    expect(await (await admin.fetch(request(location))).text()).toContain("no incremental charge");
    expect(await (await admin.fetch(request("/api/personas"))).json()).toEqual([]);
    const budget = await db
      .prepare("SELECT reservedMicros FROM seeding_runs")
      .first<{ reservedMicros: number }>();
    expect(budget!.reservedMicros).toBeGreaterThan(0);
    expect(budget!.reservedMicros).toBeLessThan(1_000_000);
  },
  30_000,
);

test.each([false, true])(
  "Codex failure after sheets=%s is correlated and redacted at the durable task boundary, retaining completed siblings",
  async (afterSheets) => {
    const { db, bucket, store } = await cloudflareFixture();
    const { storage } = memoryStorage();
    const logs = captureWorkerLogs();
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(seedCharacter(seedManifest().seeds[0]!))
      .mockResolvedValueOnce(acceptedReview());
    if (afterSheets)
      for (let i = 0; i < 2; i++)
        provider.mockImplementationOnce(async () =>
          Response.json({ data: [{ b64_json: png.toString("base64") }] }),
        );
    provider.mockImplementationOnce(async (url, init) => {
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          prompt: Schema.String,
          image: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      )(await new Request(url, init).json());
      return Response.json(
        {
          error: {
            message: `image-secret ${body.prompt} ${JSON.stringify(body.image)}`,
            code: "session_expired",
            type: "upstream_error",
          },
        },
        { status: 503 },
      );
    });
    for (let i = 0; i < (afterSheets ? 1 : 2); i++)
      provider.mockImplementationOnce(async () =>
        Response.json({ data: [{ b64_json: png.toString("base64") }] }),
      );
    vi.stubGlobal("fetch", provider);
    const admin = await cloudflareAdmin(
      {
        ...adminBindings(db, bucket),
        GEMINI_API_KEY: "text-secret",
        ADMIN_IMAGE_PROVIDER: "codex",
        CODEX_IMAGE_API_KEY: "image-secret",
      },
      storage,
    );
    const location = (await admin.fetch(uploadSeeds(1))).headers.get("location")!;
    const confirmation = await admin.fetch(request(location, { intent: "confirm", budget: "3" }));
    for (let i = 0; i < 15; i++) await admin.alarm();
    expect(provider).toHaveBeenCalledTimes(afterSheets ? 6 : 5);
    const [person] = await store.list();
    expect(person!.portraits?.photo).toBeTruthy();
    expect(person!.portraits?.anime).toBeUndefined();
    const diagnostics = logs.stderr.mock.calls.join(" ");
    for (const value of [
      confirmation.headers.get("x-request-id")!,
      "generation.api",
      "session_expired",
      '"status":503',
      "gpt-image-2.5",
    ])
      expect(diagnostics).toContain(value);
    for (const value of ["image-secret", "text-secret", "취업을 준비", png.toString("base64")])
      expect(diagnostics).not.toContain(value);
    expect(await (await admin.fetch(request(location))).text()).toContain("partial");
  },
  30_000,
);
