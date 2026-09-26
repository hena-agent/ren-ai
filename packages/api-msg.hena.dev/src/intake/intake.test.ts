import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { intake } from "./intake.ts";

const input = {
  handle: "user@example.com",
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
  sessionID: "session-1",
};

test("bookmark, redelivery, strangers, replacement, per-conversation gaps and first reply", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const fake = fakeMessages();
        const baseline = Date.parse("2026-09-25T11:00:00Z");
        yield* fake.text(input.handle, "before onboarding", baseline);
        const conversation = yield* directory.create(input);
        const prompts: { session: string; id: string; text: string }[] = [];
        let lookups = 0;
        const start = () =>
          intake(
            fake.messages,
            (handle) => {
              lookups++;
              return directory.byHandle(handle);
            },
            (session, id, text) =>
              Effect.sync(() => {
                prompts.push({ session, id, text });
              }),
            () => "Asia/Seoul",
          );
        const first = yield* start();
        const signalled: number[] = [];
        const off = first.onNew((item) => signalled.push(item.id));
        const a = yield* fake.text(input.handle, "안녕", baseline + 60_000);
        expect(prompts[0]?.id).toBe(
          `msg_${createHash("sha256").update(`${input.sessionID}\0${a.guid}`).digest("hex")}`,
        );
        const beforeRedelivery = lookups;
        yield* fake.redeliver(a);
        expect(lookups).toBe(beforeRedelivery);
        yield* fake.text("stranger@example.com", "stranger", baseline + 120_000);
        const b = yield* fake.text(input.handle, "또", baseline + 3_660_000);
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toEqual({
          session: input.sessionID,
          id: prompts[0]?.id,
          text: '<message at="2026-09-25 Fri 20:01">안녕</message>',
        });
        expect(prompts[0]?.id).toMatch(/^msg_[0-9a-f]{64}$/);
        expect(prompts[1]!.text).toBe(
          '<gap>1h 0m later</gap>\n<message at="2026-09-25 Fri 21:01">또</message>',
        );
        expect(signalled).toEqual([conversation.id, conversation.id]);
        off();
        yield* fake.text(input.handle, "third", baseline + 3_720_000);
        const beforeOldRow = lookups;
        yield* fake.redeliver(a);
        expect(lookups).toBe(beforeOldRow);
        expect(signalled).toHaveLength(2);
        expect(
          (yield* sql<{ replied: number }>`SELECT replied_at AS replied FROM user`)[0]?.replied,
        ).toBe(baseline + 60_000);
        expect(
          (yield* sql<{ rowID: number }>`SELECT row_id AS rowID FROM bookmark`)[0]?.rowID,
        ).toBe(5);
        expect((yield* fake.messages.after(3)).map((row) => row.id)).toEqual([4, 5]);
        const replayed: number[] = [];
        const stop = yield* fake.messages.follow(3, (row) =>
          Effect.sync(() => {
            replayed.push(row.id);
          }),
        );
        expect(replayed).toEqual([4, 5]);
        stop();
        // A new Messages file starts numbering at one, but newer dates still catch up.
        yield* fake.replace([
          { ...b, id: 1, guid: "old", createdAt: baseline },
          { ...b, id: 2, createdAt: baseline + 3_720_000 },
          {
            ...b,
            id: 3,
            guid: "same-date",
            text: "after replacement",
            createdAt: baseline + 3_720_000,
          },
          { ...b, id: 4, guid: "outgoing", fromMe: true, createdAt: baseline + 3_750_000 },
        ]);
        const second = yield* start();
        expect(prompts.at(-1)?.text).toContain("after replacement");
        expect(prompts).toHaveLength(4);
        expect(
          (yield* sql<{ rowID: number }>`SELECT row_id AS rowID FROM bookmark`)[0]?.rowID,
        ).toBe(4);
        expect(second.onNew(() => {})()).toBe(true);
        yield* fake.replace([
          { ...b, id: 1, createdAt: baseline + 3_750_000 },
          { ...b, id: 2, createdAt: baseline + 3_720_000 },
          { ...b, id: 3, createdAt: baseline + 3_720_000 },
          {
            ...b,
            id: 4,
            guid: "on-reset-boundary",
            text: "boundary",
            createdAt: baseline + 4_200_000,
          },
          {
            ...b,
            id: 5,
            guid: "newer-guid",
            text: "newer database",
            createdAt: baseline + 4_500_000,
          },
        ]);
        yield* start();
        expect(prompts.at(-1)?.text).toContain("newer database");
        expect(prompts.at(-2)?.text).toContain("boundary");
        expect(prompts).toHaveLength(6);
        yield* fake.text(input.handle, "after unsubscribe", baseline + 4_000_000);
        expect(replayed).toEqual([4, 5]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});

test("restart replays only messages missed while stopped from the same SQLite file", async () => {
  const root = await mkdtemp(join(tmpdir(), "intake-restart-"));
  const fake = fakeMessages();
  const delivered: string[] = [];
  const run = (create: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        if (create) yield* directory.create(input);
        yield* intake(
          fake.messages,
          (handle) => directory.byHandle(handle),
          (_session, _id, text) =>
            Effect.sync(() => {
              delivered.push(text);
            }),
          () => "Asia/Seoul",
        );
        if (create) yield* fake.text(input.handle, "first", 1000);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(root, "server.sqlite") }))),
    );
  try {
    await Effect.runPromise(run(true));
    await Effect.runPromise(fake.text(input.handle, "while stopped", 2000));
    await Effect.runPromise(run(false));
    await Effect.runPromise(run(false));
    expect(delivered).toEqual([
      '<message at="1970-01-01 Thu 09:00">first</message>',
      '<message at="1970-01-01 Thu 09:00">while stopped</message>',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
