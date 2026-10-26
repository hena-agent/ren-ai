import { Effect } from "effect";
import { expect, test } from "vitest";
import { outbox } from "../outbox/outbox.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";

test("an uncertain introduction fences the greeting across replacement without repeating the service bubble", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      yield* f.sql`UPDATE conversation SET ended_at = 100`;
      yield* f.sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
        SELECT id, 'harin', 'ses_new', 200 FROM user`;
      const conversation = (yield* f.app.directory.bySession("ses_new"))!;
      const open = (uncertain: boolean) =>
        outbox(
          {
            ...f.fake.messages,
            sendText: (handle, text, guid) =>
              uncertain
                ? f.fake
                    .outgoing(handle, text, 0, "unknown", guid)
                    .pipe(Effect.andThen(Effect.fail(new Error("lost acknowledgement"))))
                : f.fake.messages.sendText(handle, text, guid),
          },
          f.ui.gestures,
          new Map([["harin", { timeZone: "Asia/Seoul" }]]),
          f.app.directory.active,
          undefined,
          { typing: false },
        );
      const sends = yield* open(true);
      expect(yield* sends.send(conversation, "hello", "greeting")).toBe("not sent: send in doubt");
      const restarted = yield* open(false);
      expect(yield* restarted.send(conversation, "hello", "greeting")).toContain(
        "earlier send is still in doubt",
      );
      const [attempt] = yield* f.sql<{
        guid: string;
        content: string;
      }>`SELECT guid, content FROM send`;
      expect(attempt!.content).toContain("[Ren AI]");
      expect(attempt!.content).not.toContain("hello");
      yield* f.fake.settle(attempt!.guid, "delivered");
      expect(yield* restarted.send(conversation, "hello", "greeting")).toContain("did go out");
      expect(yield* restarted.send(conversation, "hello", "greeting-retry")).toBe("sent");
      expect(
        yield* f.sql`SELECT content FROM send WHERE kind = 'text' AND state != 'not_sent' ORDER BY id`,
      ).toEqual([{ content: attempt!.content }, { content: "hello" }]);
    }),
  ));
