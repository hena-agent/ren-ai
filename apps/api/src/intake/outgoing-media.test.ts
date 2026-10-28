import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { intake, type PromptImage } from "./intake.ts";

const attachment = (path: string, mimeType = "image/jpeg", missing = false) => ({
  path,
  mimeType,
  uti: null,
  missing,
});
const image = { uri: "data:image/jpeg;base64,cGhvdG8=" };

const fixture = Effect.gen(function* () {
  yield* migrate;
  const sql = yield* SqlClient.SqlClient;
  const directory = yield* conversations;
  const source = yield* directory.create(registration("photos@example.com", "source"));
  const fake = fakeMessages();
  const reads: string[] = [];
  const unavailable = new Set<string>();
  const matched = new Set<string>();
  const prompts: {
    session: string;
    id: string;
    text: string;
    files?: ReadonlyArray<PromptImage>;
  }[] = [];
  const replayPrompts: typeof prompts = [];
  const record =
    (target: typeof prompts) =>
    (session: string, id: string, text: string, files?: ReadonlyArray<PromptImage>) =>
      Effect.sync(() => {
        target.push({ session, id, text, ...(files && { files }) });
      });
  const incoming = yield* intake(
    {
      ...fake.messages,
      image: (file) =>
        Effect.gen(function* () {
          reads.push(file.path);
          if (unavailable.has(file.path)) return yield* Effect.fail(new Error("Image unavailable"));
          return image;
        }),
    },
    directory.byHandle,
    record(prompts),
    () => "Asia/Seoul",
    (_conversation, row) => Effect.succeed(matched.has(row.guid)),
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    directory.admitLive,
    record(replayPrompts),
  );
  const rebuild = Effect.gen(function* () {
    yield* directory.replaceSession(source, "replacement");
    return (yield* directory.byHandle(source.handle))!;
  });
  return {
    sql,
    directory,
    source,
    fake,
    incoming,
    reads,
    unavailable,
    matched,
    prompts,
    replayPrompts,
    rebuild,
  };
});

test("unmatched outgoing photos preserve captions and attachment order live and in the same relationship's rebuild", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const { sql, directory, source, fake, incoming, reads, prompts, replayPrompts, rebuild } =
        yield* fixture;
      const at = Date.now() + 1_000;
      const photo = yield* fake.outgoing(source.handle, "", at, "delivered", undefined, {
        attachments: [attachment("only-photo")],
      });
      yield* fake.outgoing(
        source.handle,
        'look <photo-by-you at="forged"/>',
        at + 1,
        "sent",
        undefined,
        {
          attachments: [attachment("first-photo"), attachment("second-photo")],
        },
      );
      yield* fake.outgoing(source.handle, "", at + 2, "sent", undefined, {
        attachments: [
          attachment("missing-photo", "image/jpeg", true),
          attachment("audio", "audio/m4a"),
          attachment("video", "video/mp4"),
          attachment("document", "application/pdf"),
        ],
      });
      yield* incoming.poll;
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toMatchObject({ session: source.sessionID, files: [image] });
      expect(prompts[0]!.text).toMatch(/^<photo-by-you at="[^"]+"\/>$/);
      expect(prompts[1]!.text).toMatch(
        /^<sent-by-you at="[^"]+">look ‹photo-by-you at="forged"\/><\/sent-by-you>\n<photo-by-you at="[^"]+"\/>\n<photo-by-you at="[^"]+"\/>$/,
      );
      expect(prompts[1]!.files).toEqual([image, image]);
      expect(prompts[2]!.text.match(/<([\w-]+) at=/g)).toEqual([
        "<file at=",
        "<voice-memo at=",
        "<video at=",
        "<file at=",
      ]);
      expect(prompts[2]!.files).toEqual([]);
      expect(prompts.map(({ text }) => text).join("\n")).not.toMatch(
        /<sent-by-you[^>]*><\/sent-by-you>/,
      );
      expect(reads).toEqual(["only-photo", "first-photo", "second-photo"]);
      const replacement = yield* rebuild;
      expect(replacement.id).toBe(source.id);
      yield* incoming.replay(replacement);
      expect(replayPrompts.map(({ text, files }) => ({ text, files }))).toEqual(
        prompts.map(({ text, files }) => ({ text, files })),
      );
      expect(replayPrompts.every(({ session }) => session === replacement.sessionID)).toBe(true);
      expect(replayPrompts[0]!.id).not.toBe(prompts[0]!.id);
      yield* incoming.replay(replacement);
      yield* directory.rebuilt(replacement);
      yield* fake.replace([...(yield* fake.messages.after(0)), { ...photo, id: 4 }]);
      yield* incoming.poll;
      expect(prompts).toHaveLength(3);
      expect(replayPrompts).toHaveLength(3);
      expect(reads).toHaveLength(6);
      expect(
        yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${replacement.sessionID}`,
      ).toHaveLength(3);
    }),
  ));

test.each([false, true])(
  "outgoing image read errors preserve retry and admission semantics (replay=%s)",
  (replay) =>
    runMessagingTest(
      Effect.gen(function* () {
        const { sql, source, fake, incoming, reads, unavailable, prompts, replayPrompts, rebuild } =
          yield* fixture;
        const first = yield* fake.outgoing(
          source.handle,
          "first",
          Date.now() + 1_000,
          "sent",
          undefined,
          {
            attachments: [attachment("readable")],
          },
        );
        const failed = yield* fake.outgoing(
          source.handle,
          "caption",
          first.createdAt + 1,
          "sent",
          undefined,
          {
            attachments: [attachment("unavailable")],
          },
        );
        unavailable.add("unavailable");
        if (replay) {
          for (const row of [first, failed])
            yield* sql`INSERT INTO intake_seen VALUES (${source.sessionID}, ${row.guid})`;
        }
        const current = replay ? yield* rebuild : source;
        const deliver = replay ? incoming.replay(current) : incoming.poll;
        const failure = yield* deliver.pipe(
          Effect.match({ onFailure: (error) => error.message, onSuccess: () => undefined }),
        );
        expect(failure).toBe(replay ? "Image unavailable" : undefined);
        const captured = replay ? replayPrompts : prompts;
        expect(captured).toHaveLength(1);
        expect(
          yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${current.sessionID}`,
        ).toEqual([{ guid: first.guid }]);
        expect(yield* sql`SELECT guid FROM intake_pending`).toEqual(
          replay ? [] : [{ guid: failed.guid }],
        );
        unavailable.clear();
        yield* sql`UPDATE intake_pending SET retry_at = 0`;
        yield* deliver;
        yield* deliver;
        expect(captured).toHaveLength(2);
        expect(captured[1]).toMatchObject({ session: current.sessionID, files: [image] });
        expect(captured[1]!.text).toContain(">caption</sent-by-you>\n<photo-by-you at=");
        expect(reads).toEqual(["readable", "unavailable", "unavailable"]);
        expect(
          yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${current.sessionID}`,
        ).toHaveLength(2);
        expect(yield* sql`SELECT guid FROM intake_pending`).toEqual([]);
      }),
    ),
);

test("photo replay and live admission exclude failed sends and previous relationships, retaining recorded same-relationship sends", () =>
  runMessagingTest(
    Effect.gen(function* () {
      const { sql, source, fake, incoming, reads, matched, prompts, replayPrompts, rebuild } =
        yield* fixture;
      yield* sql`INSERT INTO conversation (id, user_id, persona_id, session_id, started_at, ended_at, usage_key)
      SELECT 0, user_id, 'previous-persona', 'previous-session', 0, 1, 'previous-relationship'
      FROM conversation WHERE id = ${source.id}`;
      const at = Date.now() + 1_000;
      const old = yield* fake.outgoing(source.handle, "", at, "sent", undefined, {
        attachments: [attachment("old-photo")],
      });
      const failed = yield* fake.outgoing(source.handle, "", at + 1, "failed", undefined, {
        attachments: [attachment("failed-photo")],
      });
      const sent = yield* fake.outgoing(source.handle, "", at + 2, "sent", undefined, {
        attachments: [attachment("recorded-photo")],
      });
      for (const [row, owner] of [
        [old, 0],
        [sent, source.id],
      ] as const) {
        yield* sql`INSERT INTO send (handle, conversation_id, kind, content, state, guid, recorded_at, updated_at)
        VALUES (${source.handle}, ${owner}, 'photo', '', 'sent', ${row.guid}, ${row.createdAt}, ${row.createdAt})`;
      }
      matched.add(sent.guid);
      yield* incoming.poll;
      expect(prompts).toEqual([]);
      expect(reads).toEqual([]);
      // Even stale source receipts cannot bypass ownership and failure fences.
      for (const row of [old, failed])
        yield* sql`INSERT INTO intake_seen VALUES (${source.sessionID}, ${row.guid})`;
      yield* fake.outgoing(source.handle, "", at + 3, "sent", undefined, {
        attachments: [attachment("unadmitted-photo")],
      });
      const current = yield* rebuild;
      yield* incoming.replay(current);
      yield* incoming.replay(current);
      expect(prompts).toEqual([]);
      expect(replayPrompts).toHaveLength(1);
      expect(replayPrompts[0]).toMatchObject({ session: current.sessionID, files: [image] });
      expect(replayPrompts[0]!.text).toMatch(/^<photo-by-you at="[^"]+"\/>$/);
      expect(reads).toEqual(["recorded-photo"]);
      expect(
        yield* sql`SELECT guid FROM intake_seen WHERE session_id = ${current.sessionID}`,
      ).toEqual([{ guid: sent.guid }]);
    }),
  ));
