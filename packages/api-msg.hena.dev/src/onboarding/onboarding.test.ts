import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect, Layer } from "effect";
import { HttpBody, HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { migrate } from "../database.ts";
import { conversations } from "../conversations/conversations.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "../outbox/outbox.ts";
import { conversationStarted } from "../transcript/transcript.ts";
import { onboarding, onboardingApi, noticeCopy } from "./onboarding.ts";

const input = {
  handle: "+821012345678",
  locale: "ko",
  privacyNoticeVersion: "v1",
  turnstileToken: "human",
} as const;

const client = HttpClient.make((request, url) =>
  Effect.sync(() =>
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          success:
            url.pathname.endsWith("/siteverify") &&
            request.body instanceof HttpBody.Uint8Array &&
            new TextDecoder().decode(request.body.body).includes("secret=test-secret") &&
            !new TextDecoder().decode(request.body.body).includes("invalid"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  ),
);
const dependencies = Layer.succeed(HttpClient.HttpClient, client);

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(dependencies),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );

const watcherStopped = (checks: string[]) =>
  Effect.gen(function* () {
    const count = checks.length;
    yield* Effect.sleep("300 millis");
    return count > 0 && checks.length === count;
  });

const setup = (failSend = false, deadlineMillis = 30) =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const fake = fakeMessages();
    const directory = yield* conversations;
    const sends = yield* outbox(fake.messages, fakeGestures().gestures, directory.active);
    const prompts: string[] = [];
    const sessions: string[] = [];
    const api = yield* onboarding(
      fake.messages,
      noticeCopy,
      {
        id: "persona1",
        timeZone: "Asia/Seoul",
        language: "ko",
        openingLine: "번호 받았으니까 먼저 연락해 봐",
        memory: "Remember",
        prompt: "Persona1",
      },
      (personaID) =>
        Effect.sync(() => {
          if (personaID !== "persona1") throw new Error("Unexpected persona");
          const id = `session-${sessions.length + 1}`;
          sessions.push(id);
          return { id };
        }),
      (id, text) =>
        Effect.sync(() => {
          if (id !== sessions.at(-1)) throw new Error("Unexpected session");
          prompts.push(text);
        }),
      (handle, text) =>
        failSend ? Effect.fail(new Error("record failed")) : sends.notice(handle, text),
      "test-secret",
      deadlineMillis,
    );
    return { sql, fake, api, prompts, sessions };
  });

test("reachable Handle gets one Notice, then her first prompt, and repeat onboarding sends nothing", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api, prompts, sessions } = yield* setup(false, 2000);
      expect(fake.statusChecks).toEqual([]);
      expect(yield* api.submit(input)).toBe("sent");
      expect(fake.bubbles).toEqual([{ handle: input.handle, text: noticeCopy.ko }]);
      expect(yield* fake.messages.textStatus(input.handle, 0)).toBe("sent");
      expect(yield* fake.messages.textStatus("stranger@example.com", 0)).toBe("unknown");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("<conversation-started at=");
      expect(prompts[0]).toContain("번호 받았으니까 먼저 연락해 봐\n<notice>");
      expect(prompts[0]).toContain(noticeCopy.ko);
      expect(sessions).toHaveLength(1);
      const users = yield* sql<{
        locale: string;
        consent_version: string;
        consent_language: string;
        joined_at: number;
      }>`SELECT locale, consent_version, consent_language, joined_at FROM user`;
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        locale: "ko",
        consent_version: "v1",
        consent_language: "ko",
      });
      expect(users[0]?.joined_at).toBeGreaterThan(0);
      expect(yield* sql`SELECT kind, state FROM send`).toEqual([{ kind: "notice", state: "sent" }]);
      expect(yield* sql`SELECT guid FROM send`).toEqual([{ guid: "fake-1" }]);
      expect(yield* api.submit(input)).toBe("sent");
      expect(fake.bubbles).toHaveLength(1);
      expect(yield* sql`SELECT id FROM conversation`).toHaveLength(1);
      expect(yield* watcherStopped(fake.statusChecks)).toBe(true);
    }),
  );
});

test("error 22 removes the pending User, but keeps the Notice audit row", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api, prompts } = yield* setup(false, 2000);
      fake.statuses.set(input.handle, "no_imessage");
      expect(yield* api.submit(input)).toBe("no_imessage");
      expect(yield* sql`SELECT id FROM user`).toEqual([]);
      expect(yield* sql`SELECT id FROM conversation`).toEqual([]);
      expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "failed" }]);
      expect(prompts).toEqual([]);
      expect(yield* watcherStopped(fake.statusChecks)).toBe(true);
    }),
  );
});

test("an uncertain Notice answers unknown; after it settles the Conversation starts without another send", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api, prompts } = yield* setup();
      fake.statuses.set(input.handle, "unknown");
      expect(yield* api.submit(input)).toBe("unknown");
      expect(yield* sql`SELECT joined_at FROM user`).toEqual([{ joined_at: null }]);
      expect(yield* api.submit(input)).toBe("unknown");
      expect(fake.bubbles).toHaveLength(1);
      fake.statuses.set(input.handle, "sent");
      yield* Effect.sleep("300 millis");
      expect(prompts).toHaveLength(1);
      expect(yield* sql`SELECT id FROM conversation`).toHaveLength(1);
    }),
  );
});

test("blocked and removing Handles receive no Notice or new session", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api, sessions } = yield* setup();
      yield* sql`INSERT INTO blocked (handle, blocked_at) VALUES (${input.handle}, 1)`;
      expect(yield* api.submit(input).pipe(Effect.flip)).toBe("Handle unavailable");
      expect(fake.bubbles).toEqual([]);
      expect(yield* sql`SELECT id FROM user`).toEqual([]);
      yield* sql`DELETE FROM blocked WHERE handle = ${input.handle}`;
      yield* sql`INSERT INTO removal (handle, session_id) VALUES (${input.handle}, 'old-session')`;
      expect(yield* api.submit(input).pipe(Effect.flip)).toBe("Handle unavailable");
      expect(sessions).toEqual([]);
      yield* sql`DELETE FROM removal WHERE handle = ${input.handle}`;
      fake.statuses.set(input.handle, "unknown");
      expect(yield* api.submit(input)).toBe("unknown");
      yield* sql`INSERT INTO blocked (handle, blocked_at) VALUES (${input.handle}, 2)`;
      fake.statuses.set(input.handle, "sent");
      yield* Effect.sleep("300 millis");
      expect(sessions).toEqual([]);
      expect(yield* sql`SELECT id FROM conversation`).toEqual([]);
    }),
  );
});

test("simultaneous submissions of the same Handle cannot record two Notices", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api } = yield* setup();
      fake.statuses.set(input.handle, "unknown");
      expect(yield* Effect.all([api.submit(input), api.submit(input)], { concurrency: 2 })).toEqual(
        ["unknown", "unknown"],
      );
      expect(fake.bubbles).toHaveLength(1);
      expect(yield* sql`SELECT id FROM send`).toHaveLength(1);
    }),
  );
});

test("an imsg send timeout is never retried blindly, and its later status still starts her", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api, prompts } = yield* setup();
      fake.rejected.add(input.handle);
      expect((yield* fake.messages.sendText(input.handle, "probe").pipe(Effect.flip)).message).toBe(
        "imsg send timed out",
      );
      fake.statuses.set(input.handle, "unknown");
      expect(yield* fake.messages.textStatus("stranger@example.com", 0)).toBe("unknown");
      expect(yield* api.submit(input)).toBe("unknown");
      expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "uncertain" }]);
      expect(yield* sql`SELECT guid FROM send`).toEqual([{ guid: null }]);
      expect(fake.bubbles).toHaveLength(0);
      fake.statuses.set(input.handle, "sent");
      yield* Effect.sleep("300 millis");
      expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "sent" }]);
      expect(prompts).toHaveLength(1);
      expect(yield* sql`SELECT id FROM send`).toHaveLength(1);
    }),
  );
});

test("a temporary Messages status error is watched until it settles", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api } = yield* setup();
      fake.statusFailures.add(input.handle);
      expect((yield* fake.messages.textStatus(input.handle, 0).pipe(Effect.flip)).message).toBe(
        "Messages status temporarily unavailable",
      );
      expect(yield* api.submit(input)).toBe("unknown");
      fake.statusFailures.delete(input.handle);
      yield* Effect.sleep("300 millis");
      expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "sent" }]);
      expect(fake.bubbles).toHaveLength(1);
    }),
  );
});

test("restart watches a recorded Notice without sending another one", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api, prompts } = yield* setup();
      yield* sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at)
      VALUES (${input.handle}, 'ko', 'v1', 'ko', 1)`;
      yield* sql`INSERT INTO send (handle, kind, content, state, recorded_at, updated_at)
      VALUES (${input.handle}, 'notice', ${noticeCopy.ko}, 'recorded', 1, 1)`;
      fake.statuses.set(input.handle, "sent");
      yield* api.resume;
      yield* Effect.sleep("40 millis");
      expect(prompts).toHaveLength(1);
      expect(fake.bubbles).toEqual([]);
      expect(yield* sql`SELECT state FROM send`).toEqual([{ state: "sent" }]);
    }),
  );
});

test("a failed Notice recording does not trigger a blind repeat", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { sql, fake, api } = yield* setup(true);
      expect(yield* api.submit(input)).toBe("unknown");
      expect(yield* api.submit(input)).toBe("unknown");
      expect(fake.bubbles).toEqual([]);
      expect(yield* sql`SELECT id FROM send`).toEqual([]);
    }),
  );
});

test("HTTP schema, Turnstile, and CORS reject unsafe requests without sending", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { fake, api } = yield* setup();
      expect(yield* api.submit({ ...input, handle: "UPPER@example.com" }).pipe(Effect.flip)).toBe(
        "Invalid Handle",
      );
      const unavailable = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response('{"success":true}', {
              status: 503,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      );
      expect(
        yield* api
          .submit(input)
          .pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, unavailable)), Effect.flip),
      ).toBe("Turnstile failed");
      for (const reply of [null, "wrong", {}, { success: "true" }]) {
        const malformed = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(reply), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        );
        expect(
          yield* api
            .submit(input)
            .pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, malformed)), Effect.flip),
        ).toBe("Turnstile failed");
      }
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.routes.pipe(Layer.provide(dependencies)),
      );
      const post = (body: object, origin = "https://msg.hena.dev") =>
        handler(
          new Request("http://local/onboarding", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify(body),
          }),
          Context.make(HttpClient.HttpClient, client),
        );
      try {
        expect(onboardingApi.identifier).toBe("onboarding");
        const invalid = yield* Effect.promise(() => post({ ...input, handle: "bogus" }));
        expect(invalid.status).toBe(400);
        const denied = yield* Effect.promise(() => post({ ...input, turnstileToken: "" }));
        expect(denied.status).toBe(400);
        const badToken = yield* Effect.promise(() => post({ ...input, turnstileToken: "invalid" }));
        expect(badToken.status).toBe(400);
        const allowed = yield* Effect.promise(() =>
          post({ ...input, handle: "WRONG@example.com" }),
        );
        expect(allowed.status).toBe(400);
        const preflight = yield* Effect.promise(() =>
          handler(
            new Request("http://local/onboarding", {
              method: "OPTIONS",
              headers: { origin: "https://msg.hena.dev", "access-control-request-method": "POST" },
            }),
            Context.make(HttpClient.HttpClient, client),
          ),
        );
        expect(preflight.headers.get("access-control-allow-origin")).toBe("https://msg.hena.dev");
        const stranger = yield* Effect.promise(() =>
          post({ ...input, handle: "bogus" }, "https://evil.test"),
        );
        expect(stranger.headers.get("access-control-allow-origin")).not.toBe("https://evil.test");
        expect(fake.bubbles).toEqual([]);
      } finally {
        yield* Effect.promise(dispose);
      }
    }),
  );
});

test("the in-process HTTP handler returns the site's literal answer after the Notice settles", async () => {
  await runWithDatabase(
    Effect.gen(function* () {
      const { fake, api } = yield* setup(false, 2000);
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.routes.pipe(Layer.provide(dependencies)),
      );
      try {
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://local/onboarding", {
              method: "POST",
              headers: { "content-type": "application/json", origin: "https://msg.hena.dev" },
              body: JSON.stringify(input),
            }),
            Context.make(HttpClient.HttpClient, client),
          ),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe("https://msg.hena.dev");
        expect(yield* Effect.promise(() => response.json())).toBe("sent");
        expect(fake.bubbles).toEqual([{ handle: input.handle, text: noticeCopy.ko }]);
      } finally {
        yield* Effect.promise(dispose);
      }
    }),
  );
});

test("the Greeting format stamps her own time zone", () => {
  expect(conversationStarted(0, "opening", "notice", "Asia/Seoul")).toBe(
    '<conversation-started at="1970-01-01 Thu 09:00"/>\nopening\n<notice>notice</notice>',
  );
  expect(conversationStarted(0, "hello", "notice", "UTC")).toContain('at="1970-01-01 Thu 00:00"');
});
