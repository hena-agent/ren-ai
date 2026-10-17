import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { ConversationList, ConversationDetail } from "@ren-ai/onboarding";
import { authorize } from "@ren-ai/transport/server";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { conversationStatus } from "./status.ts";
import { conversationRecords } from "./http.ts";

test("operator records expose bounded searchable User–Persona–Session bindings and survive executor absence", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const status = yield* conversationStatus(async () => [
        { id: "seoyul", name: "강서율", bio: "public", imageUrl: "" },
      ]);
      for (let index = 0; index < 26; index++)
        yield* f.app.directory.create({
          handle: `user-${index}@example.com`,
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "harin",
          sessionID: `ses_${index}`,
        });
      const records = authorize(conversationRecords(status, Effect.runPromise), "operator-secret");
      const request = (path: string, method = "GET", authorized = true) =>
        Effect.promise(() =>
          records(
            new Request(`https://api.test${path}`, {
              method,
              headers: authorized
                ? {
                    Authorization: "Bearer operator-secret",
                    "X-Operation-ID": "00000000-0000-4000-8000-000000000001",
                  }
                : {},
            }),
          ),
        );
      expect((yield* request("/management/conversations", "GET", false)).status).toBe(401);
      const first = yield* request("/management/conversations");
      expect(first.headers.get("cache-control")).toBe("no-store");
      const page = Schema.decodeUnknownSync(ConversationList)(
        yield* Effect.promise(() => first.json()),
      );
      expect(page.entries).toHaveLength(25);
      expect(page.nextBefore).not.toBeNull();
      const second = yield* request(
        `/management/conversations?before=${page.nextBefore}&filter=all`,
      );
      expect(
        Schema.decodeUnknownSync(ConversationList)(yield* Effect.promise(() => second.json()))
          .entries,
      ).toHaveLength(2);
      const match = yield* request("/management/conversations?search=ses_25");
      const matched = Schema.decodeUnknownSync(ConversationList)(
        yield* Effect.promise(() => match.json()),
      );
      expect(matched.entries[0]).toMatchObject({
        handle: "user-25@example.com",
        personaID: "harin",
        personaName: "harin",
        sessionID: "ses_25",
      });
      const detail = yield* request(`/management/conversations/${f.conversation.id}`);
      const data = Schema.decodeUnknownSync(ConversationDetail)(
        yield* Effect.promise(() => detail.json()),
      );
      expect(data.entry.personaName).toBe("강서율");
      expect(data.entry.sessionID).toBe(f.conversation.sessionID);
      expect(data.history).toHaveLength(1);
      expect(data.registrations).toEqual([]);
      for (let index = 0; index < 26; index++) {
        yield* f.sql`INSERT INTO discovery_registration(id, handle, locale, consent_version, created_at, archived_at)
        VALUES (${randomUUID()}, ${f.conversation.handle}, 'ko', 'approved', 100, ${index < 25 ? 101 : null})`;
      }
      const firstHistory = (yield* status.detail(f.conversation.id))!;
      expect(firstHistory.registrations).toHaveLength(25);
      const nextHistory = yield* request(
        `/management/conversations/${f.conversation.id}?registrationsBefore=${firstHistory.registrationNextBefore}`,
      );
      const older = Schema.decodeUnknownSync(ConversationDetail)(
        yield* Effect.promise(() => nextHistory.json()),
      );
      expect(older.registrations).toHaveLength(1);
      expect(
        new Set([...firstHistory.registrations, ...older.registrations].map((item) => item.id))
          .size,
      ).toBe(26);
      expect(older.registrationNextBefore).toBeUndefined();
      expect(
        (yield* request(
          `/management/conversations/${f.conversation.id}?registrationsBefore=invalid`,
        )).status,
      ).toBe(400);
      for (const path of [
        "/management/conversations?filter=broken",
        "/management/conversations?before=-1",
        "/management/conversations/0",
      ])
        expect((yield* request(path)).status).toBe(400);
      expect((yield* request("/management/conversations/9999")).status).toBe(404);
      expect((yield* request("/management/conversations", "POST")).status).toBe(405);
      yield* f.ending.end(f.conversation.sessionID, "private farewell", "status");
      expect((yield* status.list({ filter: "ended", search: "private@" })).entries[0]?.notice).toBe(
        "queued",
      );
      const notice = (yield* f.sql<{ notice: string }>`SELECT notice FROM conversation_end`)[0]!
        .notice;
      yield* f.sql`INSERT INTO send(handle, conversation_id, kind, content, tool_call_id, state, recorded_at, updated_at)
      VALUES (${f.conversation.handle}, ${f.conversation.id}, 'text', ${notice}, 'status:notice:0', 'recorded', 1, 1)`;
      for (const [state, expected] of [
        ["recorded", "uncertain"],
        ["uncertain", "uncertain"],
        ["sent", "sent"],
        ["delivered", "delivered"],
        ["failed", "failed"],
        ["not_sent", "failed"],
      ]) {
        yield* f.sql`UPDATE send SET state = ${state} WHERE conversation_id = ${f.conversation.id}`;
        expect((yield* status.detail(f.conversation.id))?.entry.notice).toBe(expected);
      }
      expect(JSON.stringify(yield* status.detail(f.conversation.id))).not.toContain(
        "private farewell",
      );
      const broken = yield* conversationStatus(async () => {
        throw new Error("private catalog data");
      });
      const failures: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        failures.push(String(chunk));
        return true;
      });
      try {
        const failed = yield* Effect.promise(() =>
          conversationRecords(
            broken,
            Effect.runPromise,
          )(new Request("https://api.test/management/conversations")),
        );
        expect(failed.status).toBe(503);
        expect(failures.join("")).toContain(failed.headers.get("x-request-id"));
        expect(failures.join("")).not.toMatch(
          /private catalog data|operator-secret|private@example/,
        );
      } finally {
        stderr.mockRestore();
      }
    }),
  );
});
