import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { followUps } from "./follow-ups.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { intake } from "../intake/intake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "../outbox/outbox.ts";

interface State {
  nextWakeAt: number | null;
  lastSentAt: number;
  unanswered: number;
  followedUp: number;
}

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-09-25T12:00:00Z"));
  yield* migrate;
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* conversations;
  return { sql, directory };
});

test("wakes after quiet, stops after two unanswered follow-ups, and restarts only on his reply", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, directory } = yield* setup;
        const make = (handle: string, id: string) =>
          directory.create({
            handle,
            locale: "ko",
            consentVersion: "v1",
            consentLanguage: "ko",
            personaID: "persona1",
            sessionID: id,
          });
        const first = yield* make("first@example.com", "session-first");
        const ignored = yield* make("ignored@example.com", "session-ignored");
        const blocked = yield* make("blocked@example.com", "session-blocked");
        const removed = yield* make("removed@example.com", "session-removed");
        const prompts: { session: string; id: string; text: string }[] = [];
        const create = () =>
          followUps(
            directory.active,
            () => "Asia/Seoul",
            (session, id, text) =>
              Effect.sync(() => {
                prompts.push({ session, id, text });
              }),
          );
        const state = (id: number) =>
          Effect.map(
            sql<State>`SELECT next_wake_at AS nextWakeAt,
          last_sent_at AS lastSentAt, unanswered, followed_up AS followedUp
          FROM follow_up WHERE conversation_id = ${id}`,
            (rows) => rows[0],
          );
        let follow = yield* create();
        yield* Effect.forkScoped(follow.monitor);
        expect(yield* state(ignored.id)).toBeUndefined();
        yield* follow.sent(ignored);
        yield* sql`UPDATE user SET replied_at = ${yield* Clock.currentTimeMillis} WHERE handle IN
          (${first.handle}, ${blocked.handle}, ${removed.handle})`;
        yield* follow.received(first, yield* Clock.currentTimeMillis);
        const initial = (yield* state(first.id))!.nextWakeAt!;
        expect(initial - (yield* Clock.currentTimeMillis)).toBeGreaterThanOrEqual(
          24 * 60 * 60 * 1000,
        );
        expect(initial - (yield* Clock.currentTimeMillis)).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
        yield* follow.sent(first);
        expect((yield* state(first.id))!.unanswered).toBe(0);
        expect((yield* state(first.id))!.followedUp).toBe(0);
        yield* follow.received(blocked, yield* Clock.currentTimeMillis);
        yield* follow.received(removed, yield* Clock.currentTimeMillis);
        yield* directory.block(blocked.handle);
        yield* sql`DELETE FROM user WHERE handle = ${removed.handle}`;
        yield* Effect.yieldNow;
        const due = (yield* state(first.id))!.nextWakeAt!;
        expect(due - (yield* Clock.currentTimeMillis)).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
        expect(due - (yield* Clock.currentTimeMillis)).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
        yield* TestClock.setTime(due - 1);
        expect(prompts).toEqual([]);
        yield* TestClock.adjust(1);
        yield* Effect.yieldNow;
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          session: first.sessionID,
          id: `msg_checked_${first.id}_${due}`,
        });
        expect(prompts[0]?.text).toMatch(
          /^<checked-phone at="\d{4}-\d\d-\d\d \w{3} \d\d:\d\d"\/>$/,
        );
        const later = (yield* state(first.id))!.nextWakeAt!;
        expect(later - due).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
        expect(later - due).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
        yield* follow.sent(first);
        yield* follow.sent(first);
        expect((yield* state(first.id))!.unanswered).toBe(1);
        expect((yield* state(first.id))!.followedUp).toBe(1);
        const next = (yield* state(first.id))!.nextWakeAt!;
        expect(next - (yield* Clock.currentTimeMillis)).toBeGreaterThanOrEqual(
          3 * 24 * 60 * 60 * 1000,
        );
        expect(next - (yield* Clock.currentTimeMillis)).toBeLessThanOrEqual(
          7 * 24 * 60 * 60 * 1000,
        );
        yield* TestClock.setTime(next);
        yield* Effect.yieldNow;
        expect(prompts).toHaveLength(2);
        yield* follow.sent(first);
        expect(yield* state(first.id)).toMatchObject({ unanswered: 2, nextWakeAt: null });
        yield* TestClock.adjust("20 days");
        expect(prompts).toHaveLength(2);
        yield* follow.received(first, yield* Clock.currentTimeMillis);
        expect((yield* state(first.id))!.unanswered).toBe(0);
        yield* TestClock.setTime((yield* state(first.id))!.nextWakeAt!);
        yield* Effect.yieldNow;
        expect(prompts).toHaveLength(3);
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
      ),
    ),
  );
});

test("restores existing replied Conversations and their persisted wake on restart", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, directory } = yield* setup;
        const existing = yield* directory.create({
          handle: "returning@example.com",
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "persona1",
          sessionID: "returning",
        });
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE user SET replied_at = ${now} WHERE handle = ${existing.handle}`;
        const prompts: string[] = [];
        let checked = false;
        let allowed = false;
        const allowedAtPrompt: boolean[] = [];
        const make = () =>
          followUps(
            (conversation) =>
              checked
                ? directory.active(conversation).pipe(
                    Effect.tap((active) =>
                      Effect.sync(() => {
                        allowed = active;
                      }),
                    ),
                  )
                : Effect.sync(() => {
                    checked = true;
                    allowed = false;
                    return false;
                  }),
            () => "Asia/Seoul",
            (_session, id) =>
              Effect.sync(() => {
                prompts.push(id);
                allowedAtPrompt.push(allowed);
              }),
          );
        const original = yield* make();
        const [row] = yield* sql<{
          due: number;
        }>`SELECT next_wake_at AS due FROM follow_up WHERE conversation_id = ${existing.id}`;
        expect(row?.due).toBeGreaterThan(now);
        expect(row!.due - now).toBeLessThanOrEqual(2 * 24 * 60 * 60 * 1000);
        // Recreating the module simulates process restart: it must not randomize the saved time.
        const restarted = yield* make();
        const [saved] = yield* sql<{
          due: number;
        }>`SELECT next_wake_at AS due FROM follow_up WHERE conversation_id = ${existing.id}`;
        expect(saved?.due).toBe(row?.due);
        yield* Effect.forkScoped(restarted.monitor);
        yield* TestClock.setTime(row!.due);
        expect(checked).toBe(true);
        yield* Effect.yieldNow;
        expect(prompts).toEqual([`msg_checked_${existing.id}_${row!.due}`]);
        expect(allowedAtPrompt).toEqual([true]);
        expect(original).toBeDefined();
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
      ),
    ),
  );
});

test("incoming tapbacks, manual sends, tool texts and her tapbacks reset the quiet spell", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, directory } = yield* setup;
        const conversation = yield* directory.create({
          handle: "both@example.com",
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "persona1",
          sessionID: "both",
        });
        const fake = fakeMessages();
        const follow = yield* followUps(
          directory.active,
          () => "Asia/Seoul",
          () => Effect.void,
        );
        const sends = yield* outbox(
          fake.messages,
          fakeGestures().gestures,
          new Map([["persona1", { timeZone: "Asia/Seoul" }]]),
          directory.active,
        );
        sends.onSent(follow.sent);
        yield* intake(
          fake.messages,
          directory.byHandle,
          () => Effect.void,
          () => "Asia/Seoul",
          sends.reconcile,
          follow.received,
        );
        const at = yield* Clock.currentTimeMillis;
        const first = yield* fake.text(conversation.handle, "hi", at);
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(at);
        yield* TestClock.adjust("1 hour");
        const manualAt = yield* Clock.currentTimeMillis;
        yield* fake.outgoing(conversation.handle, "by hand", manualAt);
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(manualAt);
        yield* TestClock.adjust("1 hour");
        yield* fake.outgoing(
          conversation.handle,
          "pending",
          yield* Clock.currentTimeMillis,
          "unknown",
        );
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(manualAt);
        yield* TestClock.adjust("1 hour");
        const deliveredAt = yield* Clock.currentTimeMillis;
        yield* fake.outgoing(conversation.handle, "delivered", deliveredAt, "delivered");
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(deliveredAt);
        yield* TestClock.adjust("1 hour");
        const failedAt = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
          VALUES (${conversation.handle}, ${conversation.id}, 'text', 'failed text', 'failed-call', 'recorded', ${failedAt}, ${failedAt})`;
        yield* fake.outgoing(conversation.handle, "failed text", failedAt, "failed");
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(deliveredAt);
        yield* TestClock.adjust("1 hour");
        const toolAt = yield* Clock.currentTimeMillis;
        expect(yield* sends.send(conversation, "hello", "tool-send")).toBe("sent");
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(toolAt);
        yield* TestClock.adjust("1 hour");
        const [alreadySent] = (yield* fake.messages.after(0)).filter(
          (row) => row.guid === "fake-1",
        );
        yield* sends.reconcile(conversation, alreadySent!);
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(toolAt);
        const tapAt = yield* Clock.currentTimeMillis;
        expect(yield* sends.react(conversation, "like", "tool-react", first.guid)).toBe(
          "reacted like",
        );
        expect((yield* state(sql, conversation.id))?.lastSentAt).toBe(tapAt);
        yield* sql`UPDATE follow_up SET unanswered = 1, wake_pending = 1 WHERE conversation_id = ${conversation.id}`;
        yield* TestClock.adjust("1 hour");
        const replyAt = yield* Clock.currentTimeMillis;
        yield* fake.text(conversation.handle, "tapback", replyAt);
        expect(yield* state(sql, conversation.id)).toMatchObject({
          lastSentAt: replyAt,
          unanswered: 0,
        });
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
      ),
    ),
  );
}, 20000);

const state = (sql: SqlClient.SqlClient, id: number) =>
  Effect.map(
    sql<State>`SELECT last_sent_at AS lastSentAt, next_wake_at AS nextWakeAt,
      unanswered, followed_up AS followedUp FROM follow_up WHERE conversation_id = ${id}`,
    (rows) => rows[0],
  );
