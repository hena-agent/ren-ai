import { Deferred, Effect, Fiber, Result } from "effect";
import { expect, test } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { Persona } from "@ren-ai/personas";
import { prepareMessaging } from "../application-tools.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { conversationEndings } from "./end.ts";
import { migrate } from "../database.ts";
import { exportApplicationState, importApplicationState } from "../state-snapshot.ts";
import { relationshipFixture as fixture } from "../../test/relationship.test-helper.ts";

test("a persona can end only her own relationship, stop all normal actions and deliver one farewell and reselection notice", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(
        Result.isFailure(
          yield* Effect.result(f.app.tools.endConversation("ses_stranger", "bye", "foreign")),
        ),
      ).toBe(true);
      expect(
        yield* f.app.tools.endConversation(
          f.conversation.sessionID,
          "이 대화는 여기까지 할게요.",
          "end-1",
        ),
      ).toContain("Conversation ended");
      expect(
        yield* f.app.tools.endConversation(f.conversation.sessionID, "다른 인사", "end-2"),
      ).toBe("Conversation already ended");
      expect(yield* f.app.directory.byHandle(f.conversation.handle)).toBeUndefined();
      expect(yield* f.app.directory.bySession(f.conversation.sessionID)).toBeUndefined();
      expect(yield* f.app.directory.all()).toEqual([]);
      expect(yield* f.app.directory.active(f.conversation)).toBe(false);
      let admitted = false;
      yield* f.app.directory.admit(
        f.conversation.sessionID,
        Effect.sync(() => {
          admitted = true;
        }),
      );
      expect(admitted).toBe(false);
      for (const action of [
        f.app.tools.send(f.conversation.sessionID, "안녕?", "after-end"),
        f.app.tools.wait(f.conversation.sessionID, 1),
        f.app.tools.read(f.conversation.sessionID),
      ])
        expect(Result.isFailure(yield* Effect.result(action))).toBe(true);
      expect(yield* f.app.tools.react(f.conversation.sessionID, "like", "after-react")).toContain(
        "no Conversation",
      );
      expect(yield* f.app.sends.send(f.conversation, "stale execution", "stale")).toContain(
        "unavailable",
      );
      yield* f.app.endings.tick;
      yield* f.app.endings.tick;
      expect(f.fake.bubbles).toHaveLength(2);
      expect(f.fake.bubbles[0]?.text).toBe("이 대화는 여기까지 할게요.");
      expect(f.fake.bubbles[1]?.text).toContain("https://renai.im/#reselect=");
      expect(f.fake.notifications).toHaveLength(1);
      expect(f.fake.notifications[0]?.text).toContain("답장을 확인하지 않습니다");
      expect(
        (yield* f.fake.messages.recent(f.conversation.handle, 0)).map((row) => row.text),
      ).toEqual(["이 대화는 여기까지 할게요."]);
      expect(yield* f.sql`SELECT content FROM send`).toEqual([
        { content: "이 대화는 여기까지 할게요." },
      ]);
      expect(yield* f.sql`SELECT 1 FROM blocked`).toEqual([]);
      const snapshot = yield* exportApplicationState;
      yield* Effect.promise(() =>
        withContactDatabase(
          Effect.gen(function* () {
            yield* migrate;
            yield* importApplicationState(snapshot);
            const restarted = yield* prepareMessaging(f.personas, f.fake.messages, f.ui.gestures);
            expect(yield* restarted.directory.byHandle(f.conversation.handle)).toBeUndefined();
            yield* restarted.endings.tick;
            expect(f.fake.bubbles).toHaveLength(2);
          }),
        ),
      );
    }),
  );
});

test("ending validation and persistence failures are correlated without logging private farewell or contact data", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const farewell of ["", " ", "x".repeat(1001)]) {
        expect(
          Result.isFailure(
            yield* Effect.result(f.ending.end(f.conversation.sessionID, farewell, "invalid")),
          ),
        ).toBe(true);
      }
      yield* f.sql`CREATE TRIGGER fail_ending BEFORE INSERT ON conversation_end BEGIN SELECT RAISE(ABORT, 'private failure'); END`;
      const result = yield* Effect.result(
        f.ending.end(f.conversation.sessionID, "private farewell", "end-private"),
      );
      expect(Result.isFailure(result)).toBe(true);
      const last = f.logs.at(-1)!;
      expect(last).toMatchObject({
        operation: "conversation.end",
        stage: "ending.commit",
        outcome: "failed",
        level: "error",
      });
      expect(last.causeName).toBeDefined();
      expect(last.stack).toBeDefined();
      if (Result.isFailure(result)) expect(result.failure.message).toContain(last.requestId);
      expect(JSON.stringify(f.logs)).not.toMatch(
        /private farewell|821099999999|private failure|end-private/,
      );
      expect(yield* f.app.directory.active(f.conversation)).toBe(true);
    }),
  );
});

test("an ending waits for observed delivery after a lost acknowledgement and never resends an uncertain farewell", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      const ending = f.ending;
      yield* ending.end(f.conversation.sessionID, "마지막 인사", "lost");
      // Recreate the persisted ambiguous attempt left by a crashed process.
      yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${f.conversation.handle}, ${f.conversation.id}, 'text', '마지막 인사', 'lost:farewell:0', 'uncertain', 0, 0)`;
      yield* ending.tick;
      expect(f.fake.bubbles).toHaveLength(1);
      yield* f.fake.outgoing(f.conversation.handle, "마지막 인사", 1, "delivered");
      const restarted = yield* conversationEndings(
        f.app.directory,
        f.app.sends,
        f.fake.messages,
        f.ui.gestures,
        f.personas,
        (event) => f.logs.push(event),
      );
      yield* restarted.tick;
      expect(f.fake.bubbles).toHaveLength(1);
      expect(f.fake.bubbles[0]?.text).toContain("[Ren AI]");
      yield* restarted.tick;
      expect(f.fake.bubbles).toHaveLength(1);
    }),
  );
});

test("service notices and new relationship introductions respect the User's English or Japanese locale", async () => {
  for (const locale of ["en", "ja"]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`UPDATE user SET locale = ${locale}`;
        yield* f.ending.end(f.conversation.sessionID, "bye", "localized");
        yield* f.ending.tick;
        expect(f.fake.bubbles[1]?.text).toContain(
          locale === "ja" ? "関係は終了" : "relationship has ended",
        );
        yield* f.sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
        SELECT id, 'harin', 'ses_new', 200 FROM user`;
        f.personas.set("harin", fromPartial<Persona>({ id: "harin", timeZone: "Asia/Seoul" }));
        yield* f.app.tools.send("ses_new", "hello", "hello-new");
        expect(f.fake.bubbles.at(-1)?.text).toContain(
          locale === "ja" ? "別のペルソナ" : "different persona",
        );
      }),
    );
  }
});

test("a service block suppresses even queued relationship-ending notices", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.ending.end(f.conversation.sessionID, "bye", "blocked");
      yield* f.app.directory.block(f.conversation.handle);
      yield* f.ending.tick;
      expect(f.fake.bubbles).toEqual([]);
    }),
  );
});

test("an uncertain notice is reconciled after restart without being resent", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.ending.end(f.conversation.sessionID, "bye", "notice-pending");
      yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${f.conversation.handle}, ${f.conversation.id}, 'text', 'bye', 'notice-pending:farewell:0', 'sent', 0, 0)`;
      yield* f.sql`INSERT INTO ending_notification (conversation_id, call_id, state, guid)
      VALUES (${f.conversation.id}, 'notice-pending:notice:0', 'uncertain', 'notice-guid')`;
      yield* f.ending.tick;
      expect(yield* f.sql`SELECT notice_pending AS pending FROM conversation_end`).toEqual([
        { pending: 1 },
      ]);
      f.fake.notificationStatuses.set("notice-guid", "delivered");
      const restarted = yield* prepareMessaging(f.personas, f.fake.messages, f.ui.gestures);
      yield* restarted.endings.tick;
      expect(yield* f.sql`SELECT notice_pending AS pending FROM conversation_end`).toEqual([
        { pending: 0 },
      ]);
      expect(f.fake.bubbles).toEqual([]);
    }),
  );
});

test("confirmed failed or rejected ending sends leave the relationship ended and emit payload-free task diagnostics", async () => {
  for (const state of ["failed", "not_sent"]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.ending.end(f.conversation.sessionID, "private farewell", "failed-delivery");
        yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
        VALUES (${f.conversation.handle}, ${f.conversation.id}, 'text', 'private farewell', 'failed-delivery:farewell:0', ${state}, 0, 0)`;
        yield* f.ending.tick;
        expect(f.logs.find((entry) => entry.stage === "ending.farewell")).toMatchObject({
          stage: "ending.farewell",
          outcome: "failed",
          level: "error",
          personaId: "seoyul",
        });
        expect(f.fake.bubbles).toHaveLength(1);
        expect(f.fake.bubbles[0]?.text).toContain("[Ren AI]");
        expect(JSON.stringify(f.logs)).not.toMatch(/private farewell|821099999999|reselect=/);
        expect(yield* f.app.directory.byHandle(f.conversation.handle)).toBeUndefined();
      }),
    );
  }
});

test("rebuilding and an operator change racing an ending cannot produce a false successful termination", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.sql`UPDATE conversation SET rebuilding = 1`;
        expect(
          Result.isFailure(
            yield* Effect.result(f.ending.end(f.conversation.sessionID, "bye", "rebuilding")),
          ),
        ).toBe(true);
        yield* f.sql`UPDATE conversation SET rebuilding = 0`;
        const checked = yield* Deferred.make<void>();
        const { holder, release } = yield* f.holdSends;
        const ending = yield* conversationEndings(
          {
            ...f.app.directory,
            active: (conversation) =>
              f.app.directory
                .active(conversation)
                .pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
          },
          f.app.sends,
          f.fake.messages,
          f.ui.gestures,
          f.personas,
          (event) => f.logs.push(event),
        );
        const pending = yield* Effect.forkScoped(
          Effect.result(ending.end(f.conversation.sessionID, "bye", "racing")),
        );
        yield* Deferred.await(checked);
        yield* f.sql`UPDATE conversation SET rebuilding = 1`;
        yield* release;
        yield* Fiber.join(holder);
        expect(Result.isFailure(yield* Fiber.join(pending))).toBe(true);
        expect(yield* f.sql`SELECT 1 FROM conversation_end`).toEqual([]);
      }),
    ),
  );
});

test("blocked or indefinitely pending endings cannot starve later Users' reselection notices", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.ending.end(f.conversation.sessionID, "bye", "first-blocked");
      yield* f.app.directory.block(f.conversation.handle);
      for (let index = 0; index < 20; index++) {
        const conversation = yield* f.app.directory.create({
          handle: `queued-${index}@example.com`,
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "seoyul",
          sessionID: `ses_queued_${index}`,
        });
        yield* f.ending.end(conversation.sessionID, "bye", `end-queued-${index}`);
        if (index < 19) yield* f.app.directory.block(conversation.handle);
      }
      yield* f.ending.tick;
      expect(f.fake.bubbles).toHaveLength(2);
      yield* f.ending.tick;
      expect(f.fake.bubbles).toHaveLength(2);
      expect(f.fake.bubbles.every((bubble) => bubble.handle === "queued-19@example.com")).toBe(
        true,
      );
    }),
  );
});

test("a failed ending checkpoint is diagnosed and observed sends are not repeated when delivery resumes", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.ending.end(f.conversation.sessionID, "private farewell", "checkpoint");
      yield* f.sql`CREATE TRIGGER fail_ending_checkpoint BEFORE UPDATE OF farewell_pending ON conversation_end BEGIN SELECT RAISE(ABORT, 'private failure'); END`;
      yield* f.ending.tick;
      expect(f.logs.at(-1)).toMatchObject({
        stage: "ending.delivery",
        outcome: "failed",
        level: "error",
      });
      expect(JSON.stringify(f.logs)).not.toMatch(/private farewell|private failure|reselect=/);
      expect(f.fake.bubbles).toHaveLength(1);
      yield* f.sql`DROP TRIGGER fail_ending_checkpoint`;
      yield* f.ending.tick;
      expect(f.fake.bubbles).toHaveLength(2);
      expect(f.fake.bubbles[1]?.text).toContain("[Ren AI]");
    }),
  );
});
