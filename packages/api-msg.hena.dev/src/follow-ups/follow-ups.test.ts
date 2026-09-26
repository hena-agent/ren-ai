import { SqliteClient } from "@effect/sql-sqlite-node";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { followUps } from "./follow-ups.ts";

interface State {
  nextWakeAt: number | null;
  lastSentAt: number;
  unanswered: number;
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
          last_sent_at AS lastSentAt, unanswered FROM follow_up WHERE conversation_id = ${id}`,
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
