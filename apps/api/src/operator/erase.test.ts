import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { migrate } from "../database.ts";
import { conversations } from "../conversations/conversations.ts";
import { intakeQueue } from "../intake/queue.ts";
import { intake } from "../intake/intake.ts";
import { watchEdits } from "../intake/edits.ts";
import { makeOperator } from "./operator.ts";
import { registration, runMessagingTest } from "../../test/messaging.test-helper.ts";

test("removal erases pending text, edits and recovery metadata before unavailable remote work, preserving siblings and anonymous send budget", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const own = yield* directory.create(registration("erase@example.test", "ses_erase"));
      const sibling = yield* directory.create(registration("sibling@example.test", "ses_sibling"));
      const queue = yield* intakeQueue;
      yield* queue.enqueueEdit(own, "own-edit", "private edit");
      yield* queue.enqueueEdit(sibling, "sibling-edit", "keep edit");
      for (const conversation of [own, sibling]) {
        yield* sql`INSERT INTO intake_edit VALUES (${conversation.sessionID}, 'guid', 'private text', 0, 0)`;
        yield* sql`INSERT INTO reply_arrival VALUES (${conversation.sessionID}, 'msg', 0, 0)`;
        yield* sql`INSERT INTO context_seen VALUES (${conversation.sessionID}, 'guid')`;
        yield* sql`INSERT INTO failed_turn(session_id, fingerprint, failures, quota, failed_at, retry_at) VALUES (${conversation.sessionID}, 'private', 1, 0, 0, 0)`;
        yield* sql`INSERT INTO catalog_plan VALUES (${conversation.sessionID}, 'version', 'persona1')`;
        yield* sql`INSERT INTO application_checkpoint VALUES (${`replay:${conversation.sessionID}`}, 'private')`;
        yield* sql`INSERT INTO application_work(name, due) VALUES (${`turn:${conversation.sessionID}`}, 0)`;
        yield* sql`INSERT INTO usage_turn(id, session_id, started_at) VALUES (${conversation.sessionID}, ${conversation.sessionID}, 0)`;
        yield* sql`INSERT INTO usage_entry(id, session_id, source, started_at, outcome, error_type)
          VALUES (${conversation.sessionID}, ${conversation.sessionID}, 'message', 0, 'failed', 'private upstream error')`;
      }
      yield* sql`INSERT INTO notification_attempt(at) VALUES (0)`;
      yield* directory.replaceSession(own, "ses_replaced");
      const failing = yield* makeOperator(directory, () => Effect.fail(new Error("offline")));
      yield* failing.remove(own.handle).pipe(Effect.flip);
      for (const table of [
        "intake_edit",
        "reply_arrival",
        "context_seen",
        "failed_turn",
        "catalog_plan",
      ])
        expect(yield* sql`SELECT session_id FROM ${sql(table)}`).toEqual([
          { session_id: sibling.sessionID },
        ]);
      expect(yield* sql`SELECT handle FROM intake_pending`).toEqual([{ handle: sibling.handle }]);
      expect(
        yield* sql`SELECT session_id, persona_id, conversation_key FROM removal ORDER BY session_id`,
      ).toEqual([
        { session_id: own.sessionID, persona_id: own.personaID, conversation_key: own.sessionID },
        { session_id: "ses_replaced", persona_id: own.personaID, conversation_key: own.sessionID },
      ]);
      expect(yield* sql`SELECT name FROM application_checkpoint`).toEqual([
        { name: `replay:${sibling.sessionID}` },
      ]);
      expect(yield* sql`SELECT name FROM application_work WHERE name != 'metrics-report'`).toEqual([
        { name: `turn:${sibling.sessionID}` },
      ]);
      for (const table of ["usage_turn", "usage_entry"])
        expect(yield* sql`SELECT session_id FROM ${sql(table)} ORDER BY session_id`).toEqual([
          { session_id: own.sessionID },
          { session_id: sibling.sessionID },
        ]);
      expect(yield* sql`SELECT session_id FROM usage_session ORDER BY session_id`).toEqual([
        { session_id: own.sessionID },
        { session_id: "ses_replaced" },
        { session_id: sibling.sessionID },
      ]);
      const fake = fakeMessages();
      const late = yield* fake.text(own.handle, "late private text", 1);
      yield* queue.enqueue([late]);
      yield* queue.enqueueEdit(own, "late-edit", "late private edit");
      const edits = yield* watchEdits(
        fake.messages,
        queue.enqueueEdit,
        () => "Asia/Seoul",
        () => {},
        () => Effect.void,
      );
      yield* edits.remember(own, late);
      expect(yield* sql`SELECT handle FROM intake_pending`).toEqual([{ handle: sibling.handle }]);
      expect(yield* sql`SELECT session_id FROM intake_edit`).toEqual([
        { session_id: sibling.sessionID },
      ]);
      const replacement = yield* makeOperator(yield* conversations, () => Effect.void);
      expect(yield* replacement.remove(own.handle)).toBe("removed");
      expect(yield* replacement.remove(own.handle)).toBe("not_found");
      expect(yield* sql`SELECT at FROM notification_attempt`).toEqual([{ at: 0 }]);
    }),
  ));

test("an intake admission finishing after removal cannot recreate private edit or follow-up records", () =>
  runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const directory = yield* conversations;
      const own = yield* directory.create(registration("race@example.test", "ses_race"));
      const fake = fakeMessages();
      const operator = yield* makeOperator(directory, () => Effect.void);
      const incoming = yield* intake(
        fake.messages,
        directory.byHandle,
        () => operator.remove(own.handle).pipe(Effect.asVoid),
        () => "Asia/Seoul",
        undefined,
        () => Effect.die("deleted Conversation cannot regain a follow-up"),
        undefined,
        false,
      );
      yield* fake.text(own.handle, "delete during prompt", Date.now());
      yield* incoming.poll;
      for (const table of [
        "user",
        "conversation",
        "intake_edit",
        "intake_seen",
        "intake_pending",
        "intake_handle",
        "follow_up",
      ])
        expect(yield* sql`SELECT 1 FROM ${sql(table)}`).toEqual([]);
    }),
  ));
