import { randomUUID } from "node:crypto";
import { Effect, Fiber } from "effect";
import { expect, test } from "vitest";
import { SqlClient } from "effect/sql";
import { operatorEnding } from "./operator-ending.ts";
import { requestOperatorEnding } from "./http.ts";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { conversationStatus } from "./status.ts";
import { captureDiagnostics } from "../../test/diagnostics.test-helper.ts";
import { prepareMessaging } from "../application-tools.ts";

test.each(["ko", "en", "ja"])(
  "operator ending in %s commits without an executor and sends only one service notice after replacement",
  (locale) =>
    withContactDatabase(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        yield* f.sql`UPDATE user SET locale = ${locale}`;
        yield* f.sql`UPDATE conversation SET rebuilding = 1`;
        const sibling = yield* f.app.directory.create({
          handle: "+821088888888",
          personaID: "seoyul",
          sessionID: "ses_sibling",
          locale: "ko",
          consentLanguage: "ko",
          consentVersion: "v1",
        });
        yield* f.sql`INSERT INTO failed_turn(session_id, fingerprint, failures, quota, failed_at, retry_at) VALUES (${f.conversation.sessionID}, 'private', 1, 0, 0, 0)`;
        yield* f.sql`INSERT INTO application_work(name, due) VALUES (${`turn:${f.conversation.sessionID}`}, 0)`;
        const status = yield* conversationStatus(async () => []);
        const before = (yield* status.detail(f.conversation.id))!;
        const input = { id: before.entry.id, key: before.entry.key!, requestId: randomUUID() };
        yield* operatorEnding(input);
        yield* operatorEnding(input);
        yield* operatorEnding({ ...input, requestId: randomUUID() });
        expect(
          yield* f.sql`SELECT initiator, farewell_pending, notice_pending, stopped_at FROM conversation_end`,
        ).toEqual([
          { initiator: "operator", farewell_pending: 0, notice_pending: 1, stopped_at: null },
        ]);
        expect(
          yield* f.sql`SELECT 1 FROM persona_assignment WHERE handle = ${f.conversation.handle} UNION SELECT 1 FROM blocked UNION SELECT 1 FROM failed_turn`,
        ).toEqual([]);
        expect(yield* f.sql`SELECT handle, persona_id FROM persona_exclusion`).toEqual([
          { handle: f.conversation.handle, persona_id: "seoyul" },
        ]);
        expect(yield* f.app.directory.active(sibling)).toBe(true);
        const newcomer = yield* f.app.directory.create({
          handle: "+821077777777",
          personaID: "seoyul",
          sessionID: "ses_newcomer",
          locale: "ko",
          consentLanguage: "ko",
          consentVersion: "v1",
        });
        expect(yield* f.app.directory.active(newcomer)).toBe(true);
        expect(yield* f.sql`SELECT name FROM application_work`).toEqual([
          { name: "metrics-report" },
          { name: "endings" },
        ]);
        expect(yield* f.app.directory.byHandle(f.conversation.handle)).toBeUndefined();
        expect((yield* status.detail(input.id))?.entry.endedBy).toBe("operator");
        expect(f.fake.bubbles).toEqual([]);
        const restarted = yield* prepareMessaging(f.personas, f.fake.messages, f.ui.gestures);
        yield* restarted.endings.tick;
        yield* restarted.endings.tick;
        expect(f.fake.bubbles).toHaveLength(1);
        expect(f.fake.bubbles[0]?.text).toContain(
          locale === "ko" ? "운영자가" : locale === "ja" ? "運営者" : "The operator",
        );
        expect(f.fake.bubbles[0]?.text).toContain("[RenAI]");
        expect(f.fake.bubbles[0]?.text).toContain("#reselect=");
      }),
    ),
);

test("ending HTTP validates identity, rejects conflicting receipts and rolls back persistence failures with safe correlated diagnostics", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const [row] = yield* f.sql<{ key: string }>`SELECT usage_key AS key FROM conversation`;
      const input = { id: f.conversation.id, key: row!.key, requestId: randomUUID() };
      const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SqlClient.SqlClient, f.sql)));
      const request = (
        body: object | string = input,
        path = `/management/conversations/${input.id}/end`,
      ) =>
        Effect.promise(() =>
          requestOperatorEnding(
            new Request(`https://api.test${path}`, {
              method: "POST",
              body: typeof body === "string" ? body : JSON.stringify(body),
            }),
            run,
          ),
        );
      expect((yield* request({}, "/management/conversations")).status).toBe(405);
      expect((yield* request("bad-json")).status).toBe(400);
      expect((yield* request({ ...input, id: 999 })).status).toBe(400);
      expect((yield* request({ ...input, key: "b".repeat(32) })).status).toBe(409);
      expect(
        (yield* request({ ...input, id: 999 }, "/management/conversations/999/end")).status,
      ).toBe(409);
      const captured = captureDiagnostics();
      try {
        yield* f.sql`CREATE TRIGGER fail_operator_end BEFORE INSERT ON conversation_recovery BEGIN SELECT RAISE(ABORT, 'private ending payload'); END`;
        const failed = yield* request();
        expect(failed.status).toBe(503);
        expect(captured.logs.join("")).toContain(failed.headers.get("x-request-id"));
        expect(captured.logs.join("")).toContain('"causeName":');
        expect(captured.logs.join("")).not.toMatch(
          /private ending payload|821099999999|#reselect=|ses_seoyul/,
        );
        expect(yield* f.sql`SELECT 1 FROM conversation_end`).toEqual([]);
        expect(yield* f.app.directory.byHandle(f.conversation.handle)).toEqual(f.conversation);
        yield* f.sql`DROP TRIGGER fail_operator_end`;
      } finally {
        captured.restore();
      }
      const accepted = yield* request();
      expect(accepted.status).toBe(202);
      expect(accepted.headers.get("cache-control")).toBe("no-store");
      expect((yield* request()).status).toBe(202);
      expect(
        (yield* request({ ...input, id: 999 }, "/management/conversations/999/end")).status,
      ).toBe(409);
      yield* f.sql`UPDATE conversation_recovery SET action = 'notice'`;
      expect((yield* request()).status).toBe(409);
      yield* f.sql`UPDATE conversation_recovery SET action = 'end', conversation_id = ${input.id}`;
      // Deletion can reuse a numeric row ID; the immutable binding from the old page cannot end its replacement.
      yield* f.sql`DELETE FROM user`;
      expect(yield* f.sql`SELECT handle, persona_id FROM persona_exclusion`).toEqual([
        { handle: f.conversation.handle, persona_id: "seoyul" },
      ]);
      const replacement = yield* f.app.directory.create({
        handle: f.conversation.handle,
        personaID: "harin",
        sessionID: "ses_replacement",
        locale: "ko",
        consentLanguage: "ko",
        consentVersion: "v1",
      });
      expect(replacement.id).toBe(input.id);
      expect((yield* request()).status).toBe(409);
      expect(yield* f.app.directory.active(replacement)).toBe(true);
    }),
  ));

test("a waiting normal send is fenced while an already uncertain attempt survives operator ending without automatic resend", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const [row] = yield* f.sql<{ key: string }>`SELECT usage_key AS key FROM conversation`;
      const { holder, release } = yield* f.holdSends;
      const waiting = yield* Effect.forkScoped(
        f.app.sends.send(f.conversation, "late private text", "late"),
      );
      yield* f.sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at) VALUES (${f.conversation.handle}, ${f.conversation.id}, 'text', 'private uncertain text', 'uncertain', 'uncertain', 0, 0)`;
      yield* operatorEnding({ id: f.conversation.id, key: row!.key, requestId: randomUUID() });
      yield* release;
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(waiting)).toContain("unavailable");
      expect(yield* f.sql`SELECT state FROM send WHERE tool_call_id = 'uncertain'`).toEqual([
        { state: "uncertain" },
      ]);
      expect(f.fake.bubbles).toEqual([]);
    }).pipe(Effect.scoped),
  ));
