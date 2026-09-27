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
        const manual = yield* create("manual");
        const fake = fakeMessages();
        const at = (yield* sql<{
          started_at: number;
        }>`SELECT started_at FROM conversation WHERE id = ${first.id}`)[0]!.started_at;
        const reply = yield* fake.text(first.handle, "his first reply", at);
        const laterReply = yield* fake.text(first.handle, "his later reply", at + 2);
        const failed = yield* fake.outgoing(first.handle, "failed bubble", at + 30, "failed");
        const sent = yield* fake.outgoing(outgoing.handle, "already hers", at + 10, "sent");
        const notice = yield* fake.outgoing(outgoing.handle, "service notice", at + 12, "sent");
        yield* sql`INSERT INTO send (handle, kind, content, state, guid, recorded_at, updated_at)
          VALUES (${outgoing.handle}, 'notice', 'service notice', 'sent', ${notice.guid}, ${at + 12}, ${at + 12})`;
        const older = yield* fake.text(seen.handle, "already admitted", at + 15);
        const between = yield* fake.outgoing(seen.handle, "earlier than his reply", at + 17);
        const newer = yield* fake.text(seen.handle, "also admitted", at + 20);
        yield* fake.text(race.handle, "before the block", at + 25);
        yield* fake.outgoing(manual.handle, "unrecorded manual send", at + 40);
        yield* fake.replace((yield* fake.messages.after(0)).toReversed());
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
          (conversation, date) =>
            Effect.sync(() => {
              sentByHer.push({ id: conversation.id, date });
            }),
        );
        for (const conversation of [first, outgoing, seen, race, manual])
          yield* incoming.replay(conversation);
        expect(received).toEqual([
          { id: first.id, date: laterReply.createdAt },
          { id: seen.id, date: newer.createdAt },
        ]);
        expect(sentByHer).toEqual([
          { id: outgoing.id, date: sent.createdAt },
          { id: manual.id, date: at + 40 },
        ]);
        yield* sql`UPDATE follow_up SET last_sent_at = ${sent.createdAt} WHERE conversation_id = ${outgoing.id}`;
        yield* incoming.replay(outgoing);
        expect(sentByHer).toHaveLength(2);
        expect(prompts).toHaveLength(4);
        expect(prompts[0]).toContain("his first reply");
        expect(prompts[1]).toContain("his later reply");
        expect(prompts[2]).toContain("before the block");
        expect(prompts[3]).toContain("unrecorded manual send");
        expect(yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${failed.guid}`).toEqual([]);
        expect(yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${notice.guid}`).toEqual([]);
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
