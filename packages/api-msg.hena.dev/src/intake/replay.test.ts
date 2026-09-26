import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { intake } from "./intake.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";

test("replay preserves send outcomes, first reply, follow-up order and removal fencing", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const create = (name: string) =>
          directory.create({
            handle: `${name}@example.com`,
            locale: "ko",
            consentVersion: "v1",
            consentLanguage: "ko",
            personaID: "persona1",
            sessionID: name,
          });
        const first = yield* create("first");
        const outgoing = yield* create("outgoing");
        const seen = yield* create("seen");
        const race = yield* create("race");
        const fake = fakeMessages();
        const at = Date.now() + 1;
        const reply = yield* fake.text(first.handle, "his first reply", at);
        const failed = yield* fake.outgoing(first.handle, "failed bubble", at + 30, "failed");
        const sent = yield* fake.outgoing(outgoing.handle, "already hers", at + 10, "sent");
        const older = yield* fake.text(seen.handle, "already admitted", at + 15);
        const newer = yield* fake.text(seen.handle, "also admitted", at + 20);
        yield* fake.text(race.handle, "before the block", at + 25);
        for (const row of [sent, older, newer]) {
          const sessionID = row.handle === outgoing.handle ? outgoing.sessionID : seen.sessionID;
          yield* sql`INSERT INTO intake_seen (session_id, guid) VALUES (${sessionID}, ${row.guid})`;
        }
        for (const conversation of [outgoing, seen]) {
          yield* sql`INSERT INTO follow_up (conversation_id, last_sent_at)
            VALUES (${conversation.id}, ${at + 5})`;
        }
        const received: { id: number; date: number }[] = [];
        const prompts: string[] = [];
        let historyReads = 0;
        const incoming = yield* intake(
          {
            ...fake.messages,
            after: (id) =>
              fake.messages.after(id).pipe(
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
        );
        for (const conversation of [first, outgoing, seen, race])
          yield* incoming.replay(conversation);
        expect(received).toEqual([
          { id: first.id, date: reply.createdAt },
          { id: outgoing.id, date: sent.createdAt },
          { id: seen.id, date: newer.createdAt },
        ]);
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain("his first reply");
        expect(prompts[1]).toContain("before the block");
        expect(yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${failed.guid}`).toEqual([]);
        expect(
          yield* sql<{ repliedAt: number | null }>`SELECT replied_at AS repliedAt FROM user
          WHERE handle = ${first.handle}`,
        ).toEqual([{ repliedAt: reply.createdAt }]);
        expect(yield* sql`SELECT 1 FROM intake_last WHERE conversation_id = ${race.id}`).toEqual(
          [],
        );
        expect(
          yield* sql<{ repliedAt: number | null }>`SELECT replied_at AS repliedAt FROM user
          WHERE handle = ${race.handle}`,
        ).toEqual([{ repliedAt: null }]);
        yield* directory.block(first.handle);
        const before = historyReads;
        yield* incoming.replay(first);
        expect(historyReads).toBe(before);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});
