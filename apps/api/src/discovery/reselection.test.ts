import { randomUUID } from "node:crypto";
import { Context, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { expect, test, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { discoveryNotice, type DiscoveryRequest } from "@ren-ai/onboarding";
import type { Persona } from "@ren-ai/personas";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { prepareMessaging } from "../application-tools.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";
import { makeDiscoveryWeb } from "./discovery.ts";
import { firstContacts } from "./first-contact.ts";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";

const verified = Context.make(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
  ),
);

test("a delivered private reselection link admits another persona for the same User, preserving the ended relationship", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* contactFixture;
        const fake = fakeMessages();
        const ui = fakeGestures();
        const personas = new Map(
          ["luna", "harin", "jiwoo"].map((id) => [
            id,
            fromPartial<Persona>({
              id,
              published: true,
              timeZone: "Asia/Seoul",
              openingLine: "Say hello",
              language: "ko",
              prompt: `You are ${id}.`,
            }),
          ]),
        );
        const app = yield* prepareMessaging(personas, fake.messages, ui.gestures);
        const oldRegistrationID = yield* f.register("alma@example.com", ["luna"]);
        yield* f.store.select({ requestId: randomUUID(), count: 1 }, "original-selection");
        yield* f.sql`UPDATE discovery_contact SET state = 'active', session_id = 'ses_old' WHERE registration_id = ${oldRegistrationID}`;
        const previous = yield* app.directory.create({
          handle: "alma@example.com",
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "luna",
          sessionID: "ses_old",
        });
        yield* f.sql`UPDATE user SET joined_at = 10, replied_at = 20`;
        yield* f.sql`UPDATE conversation SET first_received_at = 20 WHERE id = ${previous.id}`;
        yield* app.tools.endConversation(previous.sessionID, "여기서 끝낼게요.", "end-old");
        const initialEnding = (yield* f.store.list).entries[0]?.relationshipEnd;
        expect(initialEnding?.at).toBeGreaterThan(0);
        expect(initialEnding?.noticeDelivered).toBe(false);
        const web = yield* makeDiscoveryWeb({
          catalog: async () => f.profiles,
          turnstileSecret: "secret",
        });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const registrationRequestId = randomUUID();
        const submit = (changes: Partial<DiscoveryRequest> = {}) =>
          Effect.promise(() =>
            web.handler(
              new Request("https://api.test/discovery/waitlist", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "CF-Connecting-IP": randomUUID(),
                  "X-Operation-ID": registrationRequestId,
                },
                body: JSON.stringify({
                  handle: previous.handle,
                  locale: "ko",
                  privacyNoticeVersion: discoveryNotice.version,
                  likedPersonaIDs: ["harin"],
                  turnstileToken: "human",
                  ...changes,
                }),
              }),
              verified,
            ),
          );
        expect((yield* submit()).status).toBe(400);
        expect((yield* submit({ reselectionToken: "a".repeat(64) })).status).toBe(400);
        yield* app.endings.tick;
        expect((yield* f.store.list).entries[0]?.relationshipEnd?.noticeDelivered).toBe(true);
        const token = new URL(fake.bubbles[1]!.text.split("\n").at(-1)!).hash.slice(
          "#reselect=".length,
        );
        expect(
          (yield* submit({ handle: "someone@example.com", reselectionToken: token })).status,
        ).toBe(400);
        expect((yield* submit({ likedPersonaIDs: ["luna"], reselectionToken: token })).status).toBe(
          400,
        );
        yield* f.sql`CREATE TRIGGER fail_reselection BEFORE INSERT ON discovery_like BEGIN SELECT RAISE(ABORT, 'private mutation payload'); END`;
        const diagnostics: string[] = [];
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          diagnostics.push(String(chunk));
          return true;
        });
        try {
          expect((yield* submit({ reselectionToken: token })).status).toBe(400);
        } finally {
          stderr.mockRestore();
        }
        expect(diagnostics.join("\n")).toContain(registrationRequestId);
        expect(diagnostics.join("\n")).toContain('"stage":"registration.commit"');
        expect(diagnostics.join("\n")).toContain('"causeName":');
        expect(diagnostics.join("\n")).not.toMatch(
          /private mutation payload|alma@example|reselect=|여기서 끝낼게요/,
        );
        yield* f.sql`DROP TRIGGER fail_reselection`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = yield* submit({ reselectionToken: token });
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toEqual({ status: "waiting" });
        }
        expect((yield* f.sql`SELECT id FROM discovery_registration`).length).toBe(2);
        expect(
          (yield* f.sql`SELECT registration_id FROM discovery_contact WHERE registration_id = ${oldRegistrationID}`)
            .length,
        ).toBe(1);
        expect((yield* f.store.list).eligibleCount).toBe(1);
        const selection = yield* f.store.select(
          { requestId: randomUUID(), count: 1 },
          "reselection-request",
        );
        expect(selection.entries[0]?.persona?.id).toBe("harin");
        yield* f.sql`UPDATE discovery_contact SET scheduled_at = 0`;
        const session = fromPartial<Session.Info>({ id: Session.ID.make("ses_new") });
        const prompts: string[] = [];
        const host = fromPartial<PersonaRuntime>({
          personas,
          createSession: () => Effect.succeed(session),
          sessions: {
            prompt: (input: Parameters<PersonaRuntime["sessions"]["prompt"]>[0]) =>
              Effect.sync(() => {
                prompts.push(JSON.stringify(input));
                return fromPartial<SessionInbox.User>({});
              }),
          },
        });
        const contacts = yield* firstContacts(
          host,
          fake.messages,
          app.directory,
          "test/probe",
          () => {},
        );
        yield* contacts.tick;
        const next = (yield* app.directory.byHandle(previous.handle))!;
        expect(next.personaID).toBe("harin");
        expect(next.sessionID).toBe("ses_new");
        expect(yield* f.sql`SELECT joined_at, consent_version FROM user`).toEqual([
          { joined_at: 10, consent_version: "v1" },
        ]);
        expect(
          yield* f.sql`SELECT first_received_at FROM conversation WHERE id = ${previous.id}`,
        ).toEqual([{ first_received_at: 20 }]);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).not.toMatch(/ses_old|여기서 끝낼게요/);
        expect(yield* app.tools.send(next.sessionID, "안녕하세요, 하린이에요.", "greet-new")).toBe(
          "sent",
        );
        expect(fake.bubbles.at(-1)?.text).toContain("다른 페르소나와의 새로운 대화");
        expect(yield* app.tools.send(next.sessionID, "반가워요.", "second-new")).toBe("sent");
        expect(fake.bubbles.at(-1)?.text).toBe("반가워요.");
        expect((yield* f.sql`SELECT id FROM conversation`).length).toBe(2);
        expect((yield* f.sql`SELECT id FROM user`).length).toBe(1);
        const active = yield* submit({ reselectionToken: token });
        expect(yield* Effect.promise(() => active.json())).toEqual({ status: "active" });
        yield* app.tools.endConversation(next.sessionID, "다음 인사", "end-new");
        yield* app.endings.tick;
        expect(
          (yield* submit({ reselectionToken: token, likedPersonaIDs: ["jiwoo"] })).status,
        ).toBe(400);
        const catalog = yield* Effect.promise(() =>
          web.handler(new Request("https://api.test/discovery/personas"), verified),
        );
        expect(yield* Effect.promise(() => catalog.json())).toEqual([f.profiles[2]]);
        const latestToken = new URL(fake.bubbles.at(-1)!.text.split("\n").at(-1)!).hash.slice(
          "#reselect=".length,
        );
        expect(
          (yield* submit({ reselectionToken: latestToken, likedPersonaIDs: ["jiwoo"] })).status,
        ).toBe(200);
        yield* f.sql`DELETE FROM discovery_registration WHERE handle = ${previous.handle}`;
        expect(
          (yield* submit({ reselectionToken: latestToken, likedPersonaIDs: ["jiwoo"] })).status,
        ).toBe(400);
      }),
    ),
  );
});

test("a valid latest ending link permits reselection before the service can confirm notice delivery", async () => {
  await withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        yield* f.ending.end(f.conversation.sessionID, "bye", "eligibility");
        const [ending] = yield* f.sql<{ notice: string }>`SELECT notice FROM conversation_end`;
        const token = new URL(ending!.notice.split("\n").at(-1)!).hash.slice("#reselect=".length);
        const web = yield* makeDiscoveryWeb({
          catalog: async () => [{ id: "harin", name: "하린", bio: "public", imageUrl: "" }],
          turnstileSecret: "secret",
        });
        yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
        const response = yield* Effect.promise(() =>
          web.handler(
            new Request("https://api.test/discovery/waitlist", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                handle: f.conversation.handle,
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                likedPersonaIDs: ["harin"],
                turnstileToken: "human",
                reselectionToken: token,
              }),
            }),
            verified,
          ),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({ status: "waiting" });
        yield* f.ending.tick;
        expect(f.fake.bubbles).toEqual([]);
      }),
    ),
  );
});
