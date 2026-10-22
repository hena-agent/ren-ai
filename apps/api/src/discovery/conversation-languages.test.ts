import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { conversationLanguages } from "./conversation-languages.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { parseConversationState, serializeInitialState } from "@ren-ai/personas";
import type { ContactDiagnostic } from "./diagnostics.ts";

test("operator current-language reads use shared Persona State and expose no relationship memory or private instructions", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* contactFixture;
      const id = yield* f.register("private@example.org");
      yield* f.sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at) VALUES ('private@example.org', 'ko', 'v1', 'ko', 1, 1)`;
      yield* f.sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at) SELECT id, 'harin', 'sesBound', 1 FROM user`;
      const state = serializeInitialState({
        mood: 60,
        energy: 50,
        stress: 30,
        connection: 60,
        solitude: 40,
        affection: 15,
        traits: {},
        languageProficiency: { ko: "fluent", en: "beginner" },
      });
      const snapshot = renderSnapshot(
        {
          id: "harin",
          prompt: "Private Persona instructions",
          language: "ko",
          timeZone: "Asia/Seoul",
          openingLine: "Hi",
          memory: "Private rules",
          initial: { state, memory: "Private Memory contents" },
        },
        "Private ground rules",
      );
      const read = vi.fn<(sessionID: string) => Effect.Effect<typeof snapshot, Error>>(() =>
        Effect.succeed(snapshot),
      );
      const logs: ContactDiagnostic[] = [];
      const handler = conversationLanguages(read, (event) => logs.push(event));
      const request = (value: string = id) =>
        new Request(`https://api.test/operator/languages?registrationID=${value}`);
      let response = yield* handler(request());
      expect(response.status).toBe(200);
      expect(read).toHaveBeenCalledWith("sesBound");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        languages: { proficiency: { ko: "fluent", en: "beginner" } },
      });
      const runtime = {
        state: {
          ...parseConversationState(state),
          languageProficiency: { en: "proficient" as const },
        },
        additional: {},
        shortTerm: "Private learned expression",
        longTerm: [],
        receipts: {},
        stateChange: {
          reason: "Repeated practice",
          source: "private-message-id",
          at: "2026-10-16T10:00:00.000Z",
        },
      };
      read.mockReturnValueOnce(
        Effect.succeed({
          ...snapshot,
          runtime,
          relationship: {
            ...runtime,
            state: { ...runtime.state, languageProficiency: { en: "beginner" } },
            shortTerm: "Private relationship",
          },
        }),
      );
      response = yield* handler(request());
      const body = yield* Effect.promise(() => response.json());
      expect(body).toEqual({
        languages: { proficiency: { en: "proficient" } },
        lastStateChange: { reason: "Repeated practice", at: runtime.stateChange.at },
      });
      expect(JSON.stringify(body)).not.toContain("Private");
      const bare = { persona: snapshot.persona, agent: snapshot.agent, rules: snapshot.rules };
      read.mockReturnValueOnce(Effect.succeed(bare));
      response = yield* handler(request());
      expect(yield* Effect.promise(() => response.json())).toEqual({});
      expect((yield* handler(request("invalid"))).status).toBe(400);
      expect((yield* handler(request(randomUUID()))).status).toBe(404);
      read.mockReturnValueOnce(
        Effect.fail(Object.assign(new Error("Private upstream payload"), { code: "ECONNRESET" })),
      );
      response = yield* handler(request());
      expect(response.status).toBe(503);
      expect(logs.at(-1)).toMatchObject({
        requestId: response.headers.get("x-request-id"),
        stage: "state.read",
        outcome: "failed",
        causeCode: "ECONNRESET",
      });
      read.mockReturnValueOnce(
        Effect.succeed({
          ...snapshot,
          documents: { state: "private malformed source", memory: "Private" },
        }),
      );
      expect((yield* handler(request())).status).toBe(503);
      expect(JSON.stringify(logs)).not.toContain("Private");
      expect(JSON.stringify(logs)).not.toContain("private@example.org");
    }),
  );
});
