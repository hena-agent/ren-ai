import { Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { ConversationMessages } from "@ren-ai/onboarding";
import { SqlClient } from "effect/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { conversationMessages } from "./messages.ts";
import { conversationMessagesRequest } from "./http.ts";

const row = (id: number, fromMe = false) => ({
  id,
  guid: `message-${id}`,
  handle: "+821099999999",
  createdAt: id,
  text: `private text ${id}`,
  fromMe,
  status: fromMe ? { state: "delivered" as const, error: 0, dateRead: 70 } : null,
});

test("transport history is bounded, chronological and scoped across relationship changes", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const id = f.conversation.id;
      yield* f.sql`UPDATE conversation SET started_at = 1 WHERE id = ${id}`;
      const history = vi.fn<Effect.Success<ReturnType<typeof remoteMessages>>["history"]>(() =>
        Effect.succeed(Array.from({ length: 51 }, (_, index) => row(60 - index, index % 2 === 0))),
      );
      const first = (yield* conversationMessages({ history }, id))!;
      expect(Schema.decodeUnknownSync(ConversationMessages)(first).entries).toHaveLength(50);
      expect(first.entries[0]?.id).toBe(11);
      expect(first.nextBefore).toBe(11);
      expect(history).toHaveBeenCalledWith({
        handle: f.conversation.handle,
        since: 1,
        until: null,
      });
      expect(JSON.stringify(first)).not.toContain('"handle"');
      yield* f.sql`UPDATE conversation SET ended_at = 40 WHERE id = ${id}`;
      const [newer] = yield* f.sql<{
        id: number;
      }>`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
        SELECT user_id, 'other', 'new-session', 100 FROM conversation WHERE id = ${id} RETURNING id`;
      for (const [guid, owner] of [
        ["message-50", id],
        ["message-30", newer!.id],
      ] as const)
        yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, state, guid, recorded_at, updated_at)
        VALUES (${f.conversation.handle}, ${owner}, 'text', 'stored', 'sent', ${guid}, 1, 1)`;
      const limited = vi.fn<Effect.Success<ReturnType<typeof remoteMessages>>["history"]>(() =>
        Effect.succeed([
          row(60),
          row(55, true),
          row(50, true),
          row(40),
          row(30, true),
          {
            ...row(20),
            attachments: [
              { path: "/private/secret.png", mimeType: "image/png", uti: null, missing: false },
            ],
          },
        ]),
      );
      const ended = (yield* conversationMessages({ history: limited }, id, 61))!;
      expect(limited).toHaveBeenCalledWith({
        handle: f.conversation.handle,
        since: 1,
        until: 100,
        before: 61,
      });
      expect(ended.entries.map((entry) => entry.id)).toEqual([20, 40, 50]);
      expect(ended.entries[0]?.attachments).toEqual([{ mimeType: "image/png", missing: false }]);
      expect(JSON.stringify(ended)).not.toContain("/private");
      expect(ended.nextBefore).toBeNull();
      expect(yield* conversationMessages({ history: () => Effect.succeed([]) }, id)).toEqual({
        entries: [],
        nextBefore: null,
      });
      expect(yield* conversationMessages({ history }, 9999)).toBeUndefined();
      const plan = JSON.stringify(
        yield* f.sql`EXPLAIN QUERY PLAN SELECT guid, conversation_id FROM send WHERE guid IN ('message-30', 'message-50')`,
      );
      expect(plan).toContain("send_guid");
      const scopePlan = JSON.stringify(
        yield* f.sql`EXPLAIN QUERY PLAN SELECT started_at FROM conversation WHERE user_id = 1 AND id > 1 ORDER BY id LIMIT 1`,
      );
      expect(scopePlan).toContain("conversation_user_history");
    }),
  );
});

test("message request validates cursors and diagnoses failure without logging message content", async () => {
  const info = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        const context = yield* Effect.context<SqlClient.SqlClient>();
        const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.runPromise(Effect.provideContext(effect, context));
        const history = vi.fn<() => Effect.Effect<ReturnType<typeof row>[], Error>>(() =>
          Effect.succeed([row(1)]),
        );
        const request = (query: string, method = "GET") =>
          Effect.promise(() =>
            conversationMessagesRequest(
              new Request(`https://api.test/operator/messages?${query}`, { method }),
              { history },
              run,
            ),
          );
        for (const query of ["id=0", "id=1&before=-1", "id=1&before=1.5", "id=1&before="])
          expect((yield* request(query)).status).toBe(400);
        expect((yield* request("id=1", "POST")).status).toBe(405);
        expect((yield* request("id=99999")).status).toBe(404);
        const success = yield* request(`id=${f.conversation.id}&before=10`);
        expect(success.status).toBe(200);
        expect(success.headers.get("cache-control")).toBe("no-store");
        expect(success.headers.get("x-request-id")).toBeTruthy();
        history.mockImplementation(() =>
          Effect.fail(
            new Error("transport unavailable", {
              cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
            }),
          ),
        );
        const failed = yield* request(`id=${f.conversation.id}`);
        expect(failed.status).toBe(503);
        const diagnostic = errors.mock.calls.map(([line]) => String(line)).join("");
        expect(diagnostic).toContain(failed.headers.get("x-request-id"));
        expect(diagnostic).toContain("conversation.management");
        expect(diagnostic).toContain("ECONNRESET");
        expect(diagnostic).toContain('"causeName":"Error"');
        expect(diagnostic).not.toContain("private text");
      }),
    );
  } finally {
    info.mockRestore();
    errors.mockRestore();
  }
});
