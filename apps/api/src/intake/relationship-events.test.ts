import { Clock, Effect } from "effect";
import { expect, test } from "vitest";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { intake } from "./intake.ts";

test("late old-persona sends and pre-start incoming messages never become the new persona's conversation, live or replayed", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const { fake, app, sql, conversation: old } = yield* relationshipFixture;
      yield* app.tools.endConversation(old.sessionID, "old private farewell", "end-old");
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
      SELECT id, 'harin', 'ses_new', ${now} FROM user`;
      yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, guid, recorded_at, updated_at)
      VALUES (${old.handle}, ${old.id}, 'text', 'known old reply', 'old-send', 'sent', 'old-guid', 0, 0)`;
      yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${old.handle}, ${old.id}, 'text', 'ambiguous old reply', 'old-uncertain', 'uncertain', 0, 0)`;
      const next = (yield* app.directory.byHandle(old.handle))!;
      const prompts: string[] = [];
      const incoming = yield* intake(
        fake.messages,
        app.directory.byHandle,
        (session, id, text) =>
          Effect.sync(() => prompts.push(text)).pipe(Effect.andThen(app.pace.seen(session, [id]))),
        () => "Asia/Seoul",
        app.sends.reconcile,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        app.pace.onNew,
      );
      yield* fake.text(old.handle, "before new relationship", now - 1);
      yield* fake.outgoing(old.handle, "known old reply", now + 1, "delivered", "old-guid");
      yield* fake.outgoing(old.handle, "ambiguous old reply", now + 2);
      yield* fake.text(old.handle, "hello new persona", now + 3);
      yield* incoming.poll;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("hello new persona");
      expect(JSON.stringify(prompts)).not.toMatch(/before new|old reply|old private/);
      expect(yield* app.pace.during(next.sessionID, Effect.succeed("new relationship reply"))).toBe(
        "new relationship reply",
      );
      yield* fake.outgoing(old.handle, "manual new reply", now + 4);
      yield* incoming.poll;
      expect(prompts.at(-1)).toContain("manual new reply");
      yield* incoming.replay(next);
      expect(prompts).toHaveLength(2);
      expect(JSON.stringify(prompts)).not.toMatch(/before new|old reply|old private/);
    }),
  );
});
