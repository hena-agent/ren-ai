import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { onboarding, noticeCopy } from "./onboarding.ts";

const client = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}"))),
);

test("the site's Waitlist form stores its email, locale, answer and time over HTTP", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const api = yield* onboarding({
        messages: fakeMessages().messages,
        notice: noticeCopy,
        persona: {
          id: "persona1",
          timeZone: "Asia/Seoul",
          language: "ko",
          openingLine: "hi",
          memory: "remember",
          prompt: "persona",
        },
        createSession: () => Effect.succeed({ id: "session" }),
        prompt: () => Effect.void,
        sendNotice: () => Effect.void,
        turnstileSecret: "secret",
      });
      expect(
        yield* api
          .submit({
            handle: "person@example.com",
            locale: "ko",
            privacyNoticeVersion: "pending",
            turnstileToken: "human",
          })
          .pipe(Effect.flip),
      ).toBe("Privacy notice unavailable");
      const { handler, dispose } = HttpRouter.toWebHandler(
        api.routes.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      );
      const post = (body: object) =>
        handler(
          new Request("http://local/waitlist", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://msg.hena.dev" },
            body: JSON.stringify(body),
          }),
          Context.make(HttpClient.HttpClient, client),
        );
      try {
        for (const answer of ["no_imessage", "unknown", "full"]) {
          const response = yield* Effect.promise(() =>
            post({ email: "person@example.com", locale: "ko", answer }),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("access-control-allow-origin")).toBe("https://msg.hena.dev");
        }
        for (const body of [
          { email: "not-an-email", locale: "ko", answer: "full" },
          { email: "PERSON@example.com", locale: "ko", answer: "full" },
          { email: "person@example.com", locale: "ko", answer: "try_later" },
        ]) {
          expect((yield* Effect.promise(() => post(body))).status).toBe(400);
        }
        const rows = yield* sql<{
          email: string;
          locale: string;
          answer: string;
          created_at: number;
        }>`SELECT email, locale, answer, created_at FROM waitlist ORDER BY id`;
        expect(rows.map(({ email, locale, answer }) => ({ email, locale, answer }))).toEqual(
          ["no_imessage", "unknown", "full"].map((answer) => ({
            email: "person@example.com",
            locale: "ko",
            answer,
          })),
        );
        expect(rows.every((row) => row.created_at > 0)).toBe(true);
        yield* sql`DROP TABLE waitlist`;
        expect(
          (yield* Effect.promise(() =>
            post({ email: "person@example.com", locale: "ko", answer: "full" }),
          )).status,
        ).toBe(400);
      } finally {
        yield* Effect.promise(dispose);
      }
    }).pipe(
      Effect.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  );
});
