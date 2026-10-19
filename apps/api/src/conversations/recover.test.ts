import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { runtimeStatus, runtimeStatusRequest } from "./runtime-status.ts";

test("operator recovery is scoped, idempotent, observes uncertain sends and independently retries failed delivery", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const service = yield* runtimeStatus(
        fromPartial<PersonaRuntime>({}),
        () => Effect.succeed(false),
        f.ending,
      );
      const handler = runtimeStatusRequest(service, Effect.runPromise);
      const recover = (action: string, requestId: string = randomUUID(), id = f.conversation.id) =>
        Effect.promise(() =>
          handler(
            new Request("https://api.test/operator/conversations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, action, requestId }),
            }),
          ),
        );
      expect((yield* recover("stop")).status).toBe(409);
      yield* f.ending.end(f.conversation.sessionID, "private farewell", "recover");
      const key = randomUUID();
      expect((yield* recover("stop", key)).status).toBe(200);
      expect((yield* recover("stop", key)).status).toBe(200);
      expect((yield* recover("notice", key)).status).toBe(409);
      expect((yield* recover("stop", key, 999)).status).toBe(409);
      expect((yield* f.sql`SELECT request_id FROM conversation_recovery`).length).toBe(1);
      expect((yield* recover("notice")).status).toBe(200);
      yield* f.ending.tick;
      expect(f.fake.bubbles).toHaveLength(2);
      expect((yield* recover("farewell")).status).toBe(409);
      yield* f.sql`UPDATE send SET state = 'failed' WHERE tool_call_id = 'recover:farewell:0'`;
      expect((yield* recover("farewell")).status).toBe(200);
      yield* f.ending.tick;
      expect(f.fake.bubbles).toHaveLength(3);
      const resend = randomUUID();
      expect((yield* recover("notice", resend)).status).toBe(200);
      expect((yield* recover("notice", resend)).status).toBe(200);
      yield* f.ending.tick;
      expect(f.fake.bubbles).toHaveLength(4);
      yield* f.sql`UPDATE send SET state = 'uncertain', guid = NULL, attempt_id = NULL, recorded_at = 9999999999999 WHERE tool_call_id = 'recover:notice:1'`;
      expect((yield* recover("notice")).status).toBe(409);
      expect(f.fake.bubbles).toHaveLength(4);
      yield* f.sql`UPDATE conversation_end SET consumed_at = 1`;
      expect((yield* recover("notice")).status).toBe(409);
      expect((yield* recover("bad-action")).status).toBe(400);
      expect((yield* recover("stop", "invalid")).status).toBe(400);
      const get = (url: string, method = "GET") =>
        Effect.promise(() => handler(new Request(url, { method })));
      expect((yield* get("https://api.test/operator/conversations?id=-1")).status).toBe(400);
      expect((yield* get("https://api.test/operator/conversations?id=999")).status).toBe(404);
      expect((yield* get("https://api.test/operator/conversations", "DELETE")).status).toBe(405);
      yield* f.sql`CREATE TRIGGER fail_recovery BEFORE INSERT ON conversation_recovery BEGIN SELECT RAISE(ABORT, 'private operator payload'); END`;
      const logs: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        logs.push(String(chunk));
        return true;
      });
      try {
        const failed = yield* recover("stop");
        expect(failed.status).toBe(503);
        expect(logs.join("")).toContain(failed.headers.get("x-request-id"));
        expect(logs.join("")).not.toMatch(
          /private operator payload|private farewell|private@example|reselect=/,
        );
      } finally {
        stderr.mockRestore();
      }
    }),
  );
});
