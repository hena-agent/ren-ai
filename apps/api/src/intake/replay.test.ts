import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { intake } from "./intake.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { TestClock } from "effect/testing";
import { DeferredWork, withWorkBudget } from "../work-budget.ts";

test("replay preserves send outcomes, first reply, follow-up order and removal fencing", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const create = (name: string) =>
          Effect.gen(function* () {
            const source = yield* directory.create({
              handle: `${name}@example.com`,
              locale: "ko",
              consentVersion: "v1",
              consentLanguage: "ko",
              personaID: "persona1",
              sessionID: `${name}-source`,
            });
            yield* directory.replaceSession(source, name);
            return { ...source, sessionID: name };
          });
        const first = yield* create("first");
        const outgoing = yield* create("outgoing");
        const seen = yield* create("seen");
        const race = yield* create("race");
        const manual = yield* create("manual");
        const fake = fakeMessages();
        const at = (yield* sql<{
          started_at: number;
        }>`SELECT MAX(started_at) AS started_at FROM conversation`)[0]!.started_at;
        const reply = yield* fake.text(first.handle, "his first reply", at);
        const laterReply = yield* fake.text(first.handle, "his later reply", at + 2);
        const failed = yield* fake.outgoing(first.handle, "failed bubble", at + 30, "failed");
        const sent = yield* fake.outgoing(outgoing.handle, "already hers", at + 10, "sent");
        const older = yield* fake.text(seen.handle, "already admitted", at + 15);
        const between = yield* fake.outgoing(seen.handle, "earlier than his reply", at + 17);
        const newer = yield* fake.text(seen.handle, "also admitted", at + 20);
        yield* fake.text(race.handle, "before the block", at + 25);
        yield* fake.outgoing(manual.handle, "unrecorded manual send", at + 40);
        yield* fake.replace((yield* fake.messages.after(0)).toReversed());
        for (const row of yield* fake.messages.after(0)) {
          const sourceID = `${row.handle.split("@")[0]}-source`;
          yield* sql`INSERT INTO intake_seen VALUES (${sourceID}, ${row.guid})`;
        }
        yield* sql`UPDATE user SET replied_at = ${reply.createdAt} WHERE handle = ${first.handle}`;
        yield* sql`UPDATE conversation SET last_received_at = ${laterReply.createdAt} WHERE id = ${first.id}`;
        for (const row of [sent, older, between, newer]) {
          const sessionID = row.handle === outgoing.handle ? outgoing.sessionID : seen.sessionID;
          yield* sql`INSERT INTO intake_seen (session_id, guid) VALUES (${sessionID}, ${row.guid})`;
        }
        for (const conversation of [outgoing, seen]) {
          yield* sql`INSERT INTO follow_up (conversation_id, last_sent_at)
            VALUES (${conversation.id}, ${at + 5})`;
        }
        const received: { id: number; date: number }[] = [];
        const sentByHer: { id: number; date: number }[] = [];
        const prompts: string[] = [];
        let historyReads = 0;
        const incoming = yield* intake(
          {
            ...fake.messages,
            recent: (...args) =>
              fake.messages.recent(...args).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    historyReads++;
                  }),
                ),
              ),
          },
          directory.byHandle,
          (sessionID, _id, text) =>
            Effect.gen(function* () {
              prompts.push(text);
              if (sessionID === race.sessionID) yield* directory.block(race.handle);
            }),
          () => "Asia/Seoul",
          undefined,
          (conversation, date) =>
            Effect.sync(() => {
              received.push({ id: conversation.id, date });
            }),
          undefined,
          false,
          (conversation, date) =>
            Effect.sync(() => {
              sentByHer.push({ id: conversation.id, date });
            }),
        );
        for (const conversation of [first, outgoing, seen, race, manual])
          yield* incoming.replay(conversation);
        expect(received).toEqual([]);
        expect(sentByHer).toEqual([]);
        yield* sql`UPDATE follow_up SET last_sent_at = ${sent.createdAt} WHERE conversation_id = ${outgoing.id}`;
        yield* incoming.replay(outgoing);
        expect(sentByHer).toHaveLength(0);
        expect(prompts).toHaveLength(4);
        expect(prompts[0]).toContain("his first reply");
        expect(prompts[1]).toContain("his later reply");
        expect(prompts[2]).toContain("before the block");
        expect(prompts[3]).toContain("unrecorded manual send");
        expect(
          yield* sql`SELECT 1 FROM intake_seen WHERE session_id = ${first.sessionID} AND guid = ${failed.guid}`,
        ).toEqual([]);
        expect(
          yield* sql<{ repliedAt: number | null }>`SELECT replied_at AS repliedAt FROM user
          WHERE handle = ${first.handle}`,
        ).toEqual([{ repliedAt: reply.createdAt }]);
        expect(yield* sql`SELECT last_received_at FROM conversation WHERE id = ${race.id}`).toEqual(
          [{ last_received_at: null }],
        );
        expect(
          yield* sql<{ repliedAt: number | null }>`SELECT replied_at AS repliedAt FROM user
          WHERE handle = ${race.handle}`,
        ).toEqual([{ repliedAt: null }]);
        yield* fake.replace(
          (yield* fake.messages.after(0)).filter((row) => row.handle !== first.handle),
        );
        yield* incoming.replay(first);
        expect(
          yield* sql`SELECT last_received_at FROM conversation WHERE id = ${first.id}`,
        ).toEqual([{ last_received_at: laterReply.createdAt }]);
        yield* directory.block(first.handle);
        const before = historyReads;
        yield* incoming.replay(first);
        expect(historyReads).toBe(before);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});

test("bounded replay checkpoints resume after actor replacement without re-prompting completed rows", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const source = yield* directory.create(registration("replay@example.com", "ses_source"));
      yield* directory.replaceSession(source, "ses_replay");
      const conversation = { ...source, sessionID: "ses_replay" };
      const sql = yield* SqlClient.SqlClient;
      const fake = fakeMessages();
      const prompted: string[] = [];
      const pages: number[] = [];
      const open = intake(
        {
          ...fake.messages,
          recent: (handle, since, query) => {
            expect(query?.limit).toBe(100);
            pages.push(query!.after!);
            return fake.messages.recent(handle, since, query);
          },
        },
        directory.byHandle,
        (_session, id) =>
          Effect.sync(() => {
            prompted.push(id);
          }),
        () => "UTC",
        undefined,
        undefined,
        undefined,
        false,
      );
      let incoming = yield* open;
      for (let i = 1; i <= 101; i++) {
        const row = yield* fake.text(conversation.handle, `message-${i}`, i);
        yield* sql`INSERT INTO intake_seen VALUES (${source.sessionID}, ${row.guid})`;
      }
      yield* sql`UPDATE conversation SET last_received_at = 101, first_received_at = 1`;
      expect(yield* withWorkBudget(incoming.replay(conversation)).pipe(Effect.flip)).toBeInstanceOf(
        DeferredWork,
      );
      expect(prompted).toHaveLength(40);
      expect(JSON.stringify(yield* sql`SELECT payload FROM application_checkpoint`)).toContain(
        '\\"cursor\\":40',
      );
      incoming = yield* open;
      expect(yield* withWorkBudget(incoming.replay(conversation)).pipe(Effect.flip)).toBeInstanceOf(
        DeferredWork,
      );
      expect(prompted).toHaveLength(80);
      yield* withWorkBudget(incoming.replay(conversation));
      expect(prompted).toHaveLength(101);
      expect(new Set(prompted).size).toBe(101);
      expect(pages).toEqual([0, 40, 80]);
      yield* incoming.replay(conversation);
      expect(prompted).toHaveLength(101);
      expect(yield* sql`SELECT 1 FROM application_checkpoint`).toEqual([]);
      expect(yield* sql`SELECT last_received_at, first_received_at FROM conversation`).toEqual([
        { last_received_at: 101, first_received_at: 1 },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
