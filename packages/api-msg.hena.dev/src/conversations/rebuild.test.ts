import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { conversations } from "./conversations.ts";
import { rebuilder } from "./rebuild-session.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { intake } from "../intake/intake.ts";

const persona = {
  id: "persona1",
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "Hello",
  memory: "remember",
  prompt: "Speak Korean",
};
const handle = "user@example.com";
const conversationInput = {
  handle,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: persona.id,
};

test("missing and operator-replaced sessions replay onboarding and both sides of only their Conversation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const fake = fakeMessages();
        const directory = yield* conversations;
        const now = Date.now();
        const original = yield* directory.create({ ...conversationInput, sessionID: "old" });
        const startedAt = (yield* sql<{
          startedAt: number;
        }>`SELECT started_at AS startedAt FROM conversation`)[0]!.startedAt;
        yield* fake.text(handle, "before onboarding", startedAt - 1);
        yield* sql`INSERT INTO send (handle, kind, content, state, guid, recorded_at, updated_at)
      VALUES (${handle}, 'notice', 'notice', 'sent', 'notice-guid', ${now}, ${now})`;
        yield* fake.outgoing(handle, "notice", now + 1, "sent", "notice-guid");
        const first = yield* fake.text(handle, "first", startedAt);
        yield* fake.outgoing(handle, "her recorded send", now + 3);
        yield* fake.outgoing(handle, "her manual send", now + 4);
        yield* fake.outgoing(handle, "failed send", now + 5, "failed");
        const last = yield* fake.text(handle, "later", now + 3_600_003);
        yield* fake.text("stranger@example.com", "private", now + 3_600_004);
        const scrambled = yield* fake.messages.after(0);
        yield* fake.replace([
          scrambled[0]!,
          scrambled[1]!,
          scrambled[6]!,
          scrambled[3]!,
          scrambled[4]!,
          scrambled[5]!,
          scrambled[2]!,
          scrambled[7]!,
        ]);
        const prompts: { session: string; id: string; text: string }[] = [];
        let interrupt = false;
        const sessions = new Set(["old"]);
        const removed: string[] = [];
        let serial = 0;
        let failReplay = false;
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          (session, id, text) =>
            Effect.gen(function* () {
              if (interrupt && text.includes("later"))
                return yield* Effect.fail(new Error("interrupted"));
              prompts.push({ session, id, text });
              return undefined;
            }),
          () => persona.timeZone,
          undefined,
          undefined,
          false,
        );
        yield* incoming.start;
        const recovery = yield* rebuilder(
          directory,
          new Map([[persona.id, persona]]),
          { ko: "notice" },
          () =>
            Effect.sync(() => {
              const id = `new-${++serial}`;
              sessions.add(id);
              return { id };
            }),
          (id) => Effect.sync(() => sessions.has(id)),
          (id) =>
            Effect.sync(() => {
              sessions.delete(id);
              removed.push(id);
            }),
          (session, id, text) =>
            Effect.sync(() => {
              prompts.push({ session, id, text });
            }),
          (conversation) =>
            failReplay
              ? Effect.fail(new Error("temporary failure"))
              : incoming.replay(conversation),
        );
        expect(yield* recovery.rebuild("stranger@example.com", true)).toBe("not_found");
        expect(yield* recovery.rebuild(handle)).toBe("present");
        sessions.delete("old");
        expect(yield* recovery.missing).toBeUndefined();
        const rebuilt = (yield* directory.byHandle(handle))!;
        expect(rebuilt.sessionID).toBe("new-1");
        expect(yield* directory.active(original)).toBe(false);
        expect(prompts.map((row) => row.text)).toEqual([
          expect.stringContaining("<conversation-started"),
          expect.stringContaining("first"),
          expect.stringContaining("her recorded send"),
          expect.stringContaining("her manual send"),
          expect.stringContaining("later"),
        ]);
        expect(prompts[0]?.text).toContain("<notice>notice</notice>");
        expect(prompts.at(-1)?.text).toContain("<gap>");
        expect(prompts.some((row) => row.text.includes("before onboarding"))).toBe(false);
        const lastDate = yield* sql<{ date: number }>`SELECT date FROM intake_last`;
        expect(lastDate[0]?.date).toBe(last.createdAt);
        expect(prompts[1]?.id).not.toBe(`msg_${first.guid}`);
        expect(prompts[1]?.id).not.toBe(prompts[0]?.id);
        expect((yield* sql`SELECT row_id FROM bookmark`).length).toBe(1);
        const replayed = prompts.length;
        expect(yield* recovery.rebuild(handle)).toBe("present");
        expect(prompts).toHaveLength(replayed);
        yield* incoming.replay(original);
        expect(prompts).toHaveLength(replayed);
        failReplay = true;
        expect(Result.isFailure(yield* Effect.result(recovery.rebuild(handle, true)))).toBe(true);
        expect(yield* directory.rebuilding((yield* directory.byHandle(handle))!)).toBe(true);
        expect(yield* directory.active((yield* directory.byHandle(handle))!)).toBe(false);
        failReplay = false;
        yield* recovery.missing;
        expect(yield* directory.rebuilding((yield* directory.byHandle(handle))!)).toBe(false);
        expect(yield* directory.active((yield* directory.byHandle(handle))!)).toBe(true);
        expect(prompts.at(-1)?.session).toBe("new-2");
        expect(prompts.at(-1)?.text).toContain("later");
        expect(prompts.filter((row) => row.session === "new-2")).toHaveLength(6);
        expect(yield* recovery.rebuild(handle, true)).toBe("rebuilt");
        expect(removed).toEqual(["new-2"]);
        expect(
          prompts.filter((row) => row.text.includes("first")).map((row) => row.id),
        ).toHaveLength(3);
        expect(
          new Set(prompts.filter((row) => row.text.includes("first")).map((row) => row.id)).size,
        ).toBe(3);
        interrupt = true;
        expect(Result.isFailure(yield* Effect.result(recovery.rebuild(handle, true)))).toBe(true);
        interrupt = false;
        yield* recovery.missing;
        expect(prompts.filter((row) => row.session === "new-4")).toHaveLength(6);
        expect(
          prompts.filter((row) => row.session === "new-4" && row.text.includes("first")),
        ).toHaveLength(1);
        yield* directory.block(handle);
        expect(yield* recovery.rebuild(handle, true)).toBe("not_found");
        expect(yield* directory.bySession(original.sessionID)).toBeUndefined();
        expect(prompts.some((row) => row.text.includes(last.guid))).toBe(false);
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});

test("a concurrent block or removal cannot attach a replacement, and a missing persona fails explicitly", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const initial = yield* directory.create({ ...conversationInput, sessionID: "old" });
      const removed: string[] = [];
      const make = (
        create: () => Effect.Effect<{ readonly id: string }, Error>,
        personas = new Map([[persona.id, persona]]),
      ) =>
        rebuilder(
          directory,
          personas,
          { ko: "notice" },
          create,
          () => Effect.succeed(false),
          (id) =>
            Effect.sync(() => {
              removed.push(id);
            }),
          () => Effect.void,
          () => Effect.void,
        );
      const blocked = yield* make(() => directory.block(handle).pipe(Effect.as({ id: "unused" })));
      expect(yield* blocked.rebuild(handle)).toBe("not_found");
      expect(removed).toEqual(["unused"]);
      yield* sql`DELETE FROM blocked WHERE handle = ${handle}`;
      const noPersona = yield* make(() => Effect.succeed({ id: "new" }), new Map());
      expect((yield* noPersona.rebuild(handle).pipe(Effect.flip)).message).toContain(
        "Unknown persona",
      );
      const removedDuringRebuild = {
        ...directory,
        replaceSession: (
          conversation: Parameters<typeof directory.replaceSession>[0],
          id: string,
        ) =>
          directory
            .replaceSession(conversation, id)
            .pipe(Effect.tap(() => sql`DELETE FROM user WHERE handle = ${handle}`)),
      };
      const noOrigin = yield* rebuilder(
        removedDuringRebuild,
        new Map([[persona.id, persona]]),
        { ko: "notice" },
        () => Effect.succeed({ id: "orphan" }),
        () => Effect.succeed(false),
        (id) =>
          Effect.sync(() => {
            removed.push(id);
          }),
        () => Effect.void,
        () => Effect.void,
      );
      expect(yield* noOrigin.rebuild(handle)).toBe("not_found");
      expect(removed).toEqual(["unused", "orphan"]);
      expect(yield* noOrigin.rebuild(handle)).toBe("not_found");
      expect(yield* directory.rebuilding(initial)).toBe(false);
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

test("replay stops admitting rows when the User is blocked mid-replay", async () => {
  const fake = fakeMessages();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const directory = yield* conversations;
        const conversation = yield* directory.create({ ...conversationInput, sessionID: "new" });
        const now = Date.now() + 1;
        yield* fake.text(handle, "first", now);
        yield* fake.text(handle, "second", now + 1);
        const prompts: string[] = [];
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          (_session, _id, text) =>
            Effect.gen(function* () {
              prompts.push(text);
              yield* directory.block(handle);
            }),
          () => persona.timeZone,
          undefined,
          undefined,
          false,
        );
        yield* incoming.replay(conversation);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("first");
        yield* incoming.replay(conversation);
        expect(prompts).toHaveLength(1);
        const outbound = yield* directory.create({
          ...conversationInput,
          handle: "other@example.com",
          sessionID: "other",
        });
        yield* fake.outgoing(outbound.handle, "manual", Date.now() + 1);
        yield* incoming.replay(outbound);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("<sent-by-you");
        const pending = yield* directory.create({
          ...conversationInput,
          handle: "pending@example.com",
          sessionID: "pending",
        });
        yield* fake.text(pending.handle, "queued", Date.now() + 1);
        expect(prompts).toHaveLength(2);
        yield* incoming.start;
        expect(prompts[2]).toContain("queued");
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );
});
