import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { intake } from "./intake.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { runMessagingTest } from "../../test/messaging.test-helper.ts";

test("overlapping live polls prepare and admit a photo only once before advancing the bookmark", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const conversation = yield* directory.create({
        handle: "photo@example.com",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "persona1",
        sessionID: "session-photo",
      });
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const duplicate = yield* Deferred.make<void>();
      const fake = fakeMessages();
      let conversions = 0;
      let prompts = 0;
      const incoming = yield* intake(
        {
          ...fake.messages,
          image: () =>
            Effect.gen(function* () {
              conversions++;
              if (conversions > 1) yield* Deferred.succeed(duplicate, undefined);
              return { uri: "data:image/jpeg;base64,anBlZw==" };
            }),
        },
        directory.byHandle,
        () =>
          Effect.gen(function* () {
            prompts++;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
          }),
        () => "Asia/Seoul",
      );
      const photo = yield* fake.text(conversation.handle, "look", Date.now() + 1, {
        attachments: [
          { path: "/private/photo.heic", mimeType: "image/heic", uti: null, missing: false },
        ],
      });
      const first = yield* Effect.forkScoped(incoming.poll);
      yield* Deferred.await(entered);
      const second = yield* Effect.forkScoped(incoming.poll);
      const duplicated = yield* Effect.race(
        Effect.as(Deferred.await(duplicate), true),
        Effect.as(Effect.sleep("250 millis"), false),
      );
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(duplicated).toBe(false);
      expect(conversions).toBe(1);
      expect(prompts).toBe(1);
      expect(yield* sql`SELECT guid FROM intake_seen`).toEqual([{ guid: photo.guid }]);
      expect(yield* sql`SELECT row_id FROM bookmark WHERE id = 1`).toEqual([{ row_id: photo.id }]);
    }),
  );
});
