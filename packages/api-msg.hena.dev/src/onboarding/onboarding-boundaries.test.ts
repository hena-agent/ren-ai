import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { onboarding, noticeCopy } from "./onboarding.ts";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "../outbox/outbox.ts";

const input = {
  handle: "+821012345678",
  locale: "ko",
  privacyNoticeVersion: "v1",
  turnstileToken: "human",
} as const;
const client = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response('{"success":true}', { headers: { "content-type": "application/json" } }),
    ),
  ),
);
const dependencies = Layer.succeed(HttpClient.HttpClient, client);
const database = SqliteClient.layer({ filename: ":memory:" });
const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | HttpClient.HttpClient>,
) => Effect.runPromise(Effect.provide(Effect.provide(effect, dependencies), database));
const setup = (deadline = 30) =>
  Effect.gen(function* () {
    yield* migrate;
    const fake = fakeMessages();
    const sql = yield* SqlClient.SqlClient;
    const persona = {
      id: "persona1",
      timeZone: "Asia/Seoul",
      language: "ko",
      openingLine: "hi",
      memory: "remember",
      prompt: "persona",
    };
    const sends = yield* outbox(
      fake.messages,
      fakeGestures().gestures,
      new Map([[persona.id, persona]]),
    );
    let sessions = 0;
    const api = yield* onboarding(
      fake.messages,
      noticeCopy,
      persona,
      () => Effect.sync(() => ({ id: `session-${++sessions}` })),
      () => Effect.void,
      (handle, text) => sends.notice(handle, text),
      "secret",
      deadline,
    );
    return { sql, fake, api };
  });

const shiftedClock = (clock: Clock.Clock, time: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: time,
  currentTimeMillis: Effect.sync(time),
  currentTimeNanosUnsafe: () => BigInt(time()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(time()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: clock.sleep.bind(clock),
});

test("the per-IP window expires exactly after an hour", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { api, fake } = yield* setup(2000);
      const clock = yield* Clock.Clock;
      let now = yield* Clock.currentTimeMillis;
      const shifted = shiftedClock(clock, () => now);
      const submitAt = (index: number) =>
        api
          .submit({ ...input, handle: `person${index}@example.com` }, "1.2.3.4")
          .pipe(Effect.provideService(Clock.Clock, shifted));
      for (let index = 0; index < 5; index++) expect(yield* submitAt(index)).toBe("sent");
      expect(yield* submitAt(5)).toBe("try_later");
      now += 3_600_000;
      expect(yield* submitAt(5)).toBe("sent");
      expect(fake.bubbles).toHaveLength(6);
    }),
  );
});

test("the 7-day boundary permits a failed Notice to be tried again", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, api, fake } = yield* setup(2000);
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
      VALUES (${input.handle}, 'notice', 'notice', 'failed', ${now - 7 * 86_400_000}, ${now})`;
      fake.statuses.set(input.handle, "sent");
      const clock = yield* Clock.Clock;
      const shifted = shiftedClock(clock, () => now);
      expect(yield* api.submit(input, "ip").pipe(Effect.provideService(Clock.Clock, shifted))).toBe(
        "sent",
      );
      expect(fake.bubbles).toHaveLength(1);
    }),
  );
});

test("a prior Notice without a User does not cause another send", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, api, fake } = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
      VALUES (${input.handle}, 'notice', 'notice', 'sent', ${now}, ${now})`;
      expect(yield* api.submit(input, "ip")).toBe("unknown");
      expect(fake.bubbles).toEqual([]);
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at)
      VALUES (${input.handle}, 'ko', 'v1', 'ko', ${now})`;
      expect(yield* api.submit(input, "ip2")).toBe("unknown");
      expect(fake.bubbles).toEqual([]);
    }),
  );
});

test("an existing User with no Notice row does not get sent another one", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, api, fake } = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at)
      VALUES (${input.handle}, 'ko', 'v1', 'ko', ${now}, ${now})`;
      expect(yield* api.submit(input, "ip")).toBe("sent");
      expect(fake.bubbles).toEqual([]);
    }),
  );
});

test("HTTP submissions are grouped by CF-Connecting-IP, not by Handle", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { api, fake } = yield* setup(2000);
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.routes.pipe(Layer.provide(dependencies)),
      );
      const post = (index: number, ip?: string) =>
        handler(
          new Request("http://local/onboarding", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(ip ? { "cf-connecting-ip": ip } : {}),
            },
            body: JSON.stringify({ ...input, handle: `person${index}@example.com` }),
          }),
          Context.make(HttpClient.HttpClient, client),
        );
      try {
        for (let index = 0; index < 5; index++) {
          expect(
            yield* Effect.promise(() => post(index, "1.2.3.4")).pipe(
              Effect.flatMap((r) => Effect.promise(() => r.json())),
            ),
          ).toBe("sent");
        }
        expect(
          yield* Effect.promise(() => post(5, "1.2.3.4")).pipe(
            Effect.flatMap((r) => Effect.promise(() => r.json())),
          ),
        ).toBe("try_later");
        expect(
          yield* Effect.promise(() => post(5, "5.6.7.8")).pipe(
            Effect.flatMap((r) => Effect.promise(() => r.json())),
          ),
        ).toBe("sent");
        expect(fake.bubbles).toHaveLength(6);
      } finally {
        yield* Effect.promise(dispose);
      }
    }),
  );
});

test("requests without a CF IP share the same in-memory limit", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { api, fake } = yield* setup(2000);
      for (let index = 0; index < 5; index++) {
        expect(yield* api.submit({ ...input, handle: `person${index}@example.com` })).toBe("sent");
      }
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.routes.pipe(Layer.provide(dependencies)),
      );
      const request = new Request("http://local/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, handle: "another@example.com" }),
      });
      try {
        const response = yield* Effect.promise(() =>
          handler(request, Context.make(HttpClient.HttpClient, client)),
        );
        expect(yield* Effect.promise(() => response.json())).toBe("try_later");
        expect(fake.bubbles).toHaveLength(5);
      } finally {
        yield* Effect.promise(dispose);
      }
    }),
  );
});
