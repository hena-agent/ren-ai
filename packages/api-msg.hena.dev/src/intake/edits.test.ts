import { createHash } from "node:crypto";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Logger } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { intake } from "./intake.ts";

const user = (handle: string) => ({
  handle,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
  sessionID: `session-${handle}`,
});

const setup = (handle: string) =>
  Effect.gen(function* () {
    const start = Date.parse("2026-09-25T11:00:00Z");
    yield* TestClock.setTime(start);
    yield* migrate;
    const directory = yield* conversations;
    const conversation = yield* directory.create(user(handle));
    return { start, directory, conversation, fake: fakeMessages() };
  });

const capture = (prompts: string[]) => (_session: string, _id: string, text: string) =>
  Effect.sync(() => {
    prompts.push(text);
  });
const zone = () => "Asia/Seoul";

test("polls only active Conversations, reports each change once and stops after the window", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { start, directory, conversation: first, fake } = yield* setup("first@example.com");
        yield* directory.create(user("idle@example.com"));
        const reads: string[] = [];
        const prompts: { id: string; text: string }[] = [];
        const incoming = yield* intake(
          {
            ...fake.messages,
            recent: (handle, since) => {
              reads.push(handle);
              return fake.messages.recent(handle, since);
            },
          },
          directory.byHandle,
          (_session, id, text) =>
            Effect.sync(() => {
              prompts.push({ id, text });
            }),
          zone,
        );
        const signals: number[] = [];
        incoming.onNew((conversation) => signals.push(conversation.id));
        const a = yield* fake.text(first.handle, 'old "text"', start);
        yield* fake.text("stranger@example.com", "unwatched", start);
        yield* fake.edit(a.guid, 'edited "text"');
        yield* TestClock.adjust("1 second");
        expect(prompts.map((entry) => entry.text)).toEqual([
          '<message at="2026-09-25 Fri 20:00">old "text"</message>',
          '<edited was="old ”text”" at="2026-09-25 Fri 20:00">edited "text"</edited>',
        ]);
        expect(prompts[1]?.id).toMatch(/^edit_[0-9a-f]{64}$/);
        expect(prompts[1]?.id).toBe(
          `edit_${createHash("sha256").update([first.sessionID, a.guid, 'old "text"', 'edited "text"', "1"].join("\0")).digest("hex")}`,
        );
        expect(reads).toEqual([first.handle]);
        yield* TestClock.adjust("1 second");
        expect(prompts).toHaveLength(2);
        yield* fake.edit(a.guid, 'old "text"');
        yield* TestClock.adjust("1 second");
        yield* fake.edit(a.guid, 'edited "text"');
        yield* TestClock.adjust("1 second");
        expect(prompts[3]?.id).not.toBe(prompts[1]?.id);
        yield* fake.unsend(a.guid);
        yield* TestClock.adjust("1 second");
        expect(prompts[4]?.text).toBe('<unsent at="2026-09-25 Fri 20:00"/>');
        expect(new Set(prompts.map((entry) => entry.id)).size).toBe(5);
        expect(signals).toEqual([first.id, first.id, first.id, first.id, first.id]);
        const afterUnsend = reads.length;
        yield* TestClock.adjust("1 second");
        expect(reads).toHaveLength(afterUnsend);
        const b = yield* fake.text(first.handle, "later", start + 6000);
        yield* TestClock.adjust("1 second");
        const c = yield* fake.text(first.handle, "also here", start + 7000);
        yield* fake.edit(b.guid, "revised before newest");
        yield* TestClock.adjust("1 second");
        expect(prompts.at(-1)?.text).toContain('was="later"');
        yield* TestClock.adjust("2 minutes");
        yield* fake.unsend(b.guid);
        yield* TestClock.adjust("1 second");
        expect(prompts).toHaveLength(8);
        yield* fake.edit(b.guid, "revised");
        yield* TestClock.adjust("1 second");
        expect(prompts[8]?.text).toContain('was="revised before newest"');
        yield* fake.unsend(c.guid);
        yield* TestClock.adjust("1 second");
        expect(prompts).toHaveLength(9);
        yield* TestClock.adjust("13 minutes");
        const before = reads.length;
        yield* TestClock.adjust("1 second");
        expect(reads).toHaveLength(before);
        expect(reads).not.toContain("idle@example.com");
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
      ),
    ),
  );
});

test("restart takes current text as baseline, so changes while down are missed", async () => {
  const prompts: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const { start: time, directory, conversation, fake } = yield* setup("restart@example.com");
      const begin = () => intake(fake.messages, directory.byHandle, capture(prompts), zone);
      const start = Effect.scoped(
        Effect.gen(function* () {
          yield* begin();
          const row = yield* fake.text(conversation.handle, "first", time);
          const removed = yield* fake.text(conversation.handle, "withdrawn", time);
          return { row, removed };
        }),
      );
      const { row, removed } = yield* start;
      yield* fake.edit(row.guid, "while down");
      yield* fake.unsend(removed.guid);
      yield* fake.text(conversation.handle, "missed watch, caught up", time);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* begin();
          yield* TestClock.adjust("1 second");
          expect(prompts).toHaveLength(3);
          expect(
            prompts.every((text) => !text.startsWith("<edited") && !text.startsWith("<unsent")),
          ).toBe(true);
          yield* fake.edit(row.guid, "after restart");
          yield* fake.edit(removed.guid, "not revived");
          yield* TestClock.adjust("1 second");
          expect(prompts[3]).toContain('was="while down"');
          expect(prompts).toHaveLength(4);
        }),
      );
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.provide(TestClock.layer()),
    ),
  );
});

test("at the exact Apple deadlines the edit and unsend are still visible", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { start, directory, conversation, fake } = yield* setup("boundary@example.com");
        const prompts: string[] = [];
        yield* intake(fake.messages, directory.byHandle, capture(prompts), zone);
        const toUnsend = yield* fake.text(conversation.handle, "unsend", start);
        const toEdit = yield* fake.text(conversation.handle, "edit", start);
        yield* TestClock.adjust(119_000);
        yield* fake.unsend(toUnsend.guid);
        yield* TestClock.adjust("1 second");
        expect(prompts[2]).toContain("<unsent");
        yield* TestClock.adjust(779_000);
        // At 15 minutes the message is still eligible; after that it is not polled.
        yield* fake.edit(toEdit.guid, "edited at the deadline");
        yield* TestClock.adjust("1 second");
        expect(prompts[3]).toContain("edited at the deadline");
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
      ),
    ),
  );
});

test("the in-memory Messages fake scopes recent rows by chat and date, and edits by GUID", async () => {
  const fake = fakeMessages();
  const old = await Effect.runPromise(fake.text("one@example.com", "old", 10));
  const newer = await Effect.runPromise(fake.text("one@example.com", "new", 20));
  const other = await Effect.runPromise(fake.text("two@example.com", "other", 20));
  await Effect.runPromise(fake.edit(newer.guid, "changed"));
  expect(await Effect.runPromise(fake.messages.recent("one@example.com", 20))).toEqual([
    { ...newer, text: "changed" },
  ]);
  expect(await Effect.runPromise(fake.messages.recent("one@example.com", 10))).toEqual([
    old,
    { ...newer, text: "changed" },
  ]);
  expect(await Effect.runPromise(fake.messages.recent("two@example.com", 20))).toEqual([other]);
});

test("polling ignores missing rows rather than treating them as unsent", async () => {
  const logs: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { start, directory, conversation, fake } = yield* setup("missing@example.com");
        const prompts: string[] = [];
        let missing = false;
        yield* intake(
          {
            ...fake.messages,
            recent: (handle, since) =>
              missing ? Effect.succeed([]) : fake.messages.recent(handle, since),
          },
          directory.byHandle,
          capture(prompts),
          zone,
        );
        const row = yield* fake.text(conversation.handle, "before", start);
        missing = true;
        yield* TestClock.adjust("1 second");
        expect(logs).toEqual([]);
        expect(prompts).toHaveLength(1);
        missing = false;
        yield* fake.edit(row.guid, "after");
        yield* TestClock.adjust("1 second");
        expect(prompts[1]).toContain("after</edited>");
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
        Effect.provide(TestClock.layer()),
        Effect.withLogger(
          Logger.make<ReadonlyArray<string>, void>(({ message }) => {
            logs.push(...message);
          }),
        ),
      ),
    ),
  );
});

test("a restart does not watch a GUID until its original prompt has been admitted", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { start, directory, conversation, fake } = yield* setup("unadmitted@example.com");
      const prompts: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* intake(fake.messages, directory.byHandle, capture(prompts), zone);
          yield* fake.text(conversation.handle, "admitted", start);
        }),
      );
      const pending = yield* fake.text(conversation.handle, "pending", start);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* intake(
            { ...fake.messages, follow: () => Effect.succeed(() => {}) },
            directory.byHandle,
            capture(prompts),
            zone,
          );
          yield* fake.edit(pending.guid, "changed before admission");
          yield* TestClock.adjust("1 second");
          expect(prompts).toHaveLength(1);
        }),
      );
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
      Effect.provide(TestClock.layer()),
    ),
  );
});
