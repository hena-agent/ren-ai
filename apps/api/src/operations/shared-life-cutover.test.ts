import { Effect, Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { expect, test } from "vitest";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { withTransferClient, legacySession } from "../../test/operations-transfer.test-helper.ts";
import { runSharedLifeCutover } from "./shared-life-cutover.ts";
import type { ContactDiagnostic } from "../discovery/diagnostics.ts";
import type { Persona } from "@ren-ai/personas";

const archivedSessions = (sessions: readonly Session.Info[], persona: Persona) =>
  sessions.map((info) => ({
    info: Schema.encodeSync(Session.Info)(info),
    pending: [],
    folder: renderSnapshot(persona, "old"),
  }));

const cutoverApplication = (failure: string, session: Session.Info, persona: Persona) =>
  JSON.stringify({
    version: 1,
    tables: [
      {
        name: "conversation",
        columns: ["session_id", "persona_id", "usage_key", "ended_at", "rebuilding"],
        rows: [
          [
            failure === "missing-session" ? "ses_missing" : session.id,
            failure === "wrong-binding" ? "other" : persona.id,
            "key",
            null,
            failure === "rebuilding" ? 1 : 0,
          ],
        ],
      },
    ],
  });

test("paused cutover preserves native history and isolates old user memories from the shared life", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const session = yield* legacySession(client, root);
      const native = yield* client.session.export({ sessionID: session.id, sanitize: false });
      const persona = personas.get("persona1")!;
      const state = {
        mood: 41,
        energy: 42,
        stress: 43,
        connection: 44,
        solitude: 45,
        affection: 91,
        traits: {},
      };
      const archive = JSON.stringify({
        version: 1,
        sessions: [
          {
            ...native,
            info: Schema.encodeSync(Session.Info)(native.info),
            pending: [],
            folder: {
              ...renderSnapshot(persona, "Historical instructions"),
              runtime: {
                state,
                stateChange: {
                  source: "msg_private",
                  reason: "private reason",
                  at: "2026-10-22T00:00:00Z",
                },
                additional: {
                  trust: { value: 8, meaning: "trust in this user", reason: "private" },
                },
                shortTerm: "The user's private name and promise",
                longTerm: [],
                receipts: {},
              },
            },
          },
        ],
      });
      const application = JSON.stringify({
        version: 1,
        tables: [
          {
            name: "conversation",
            columns: ["session_id", "persona_id", "usage_key", "ended_at", "registration_id"],
            rows: [[session.id, persona.id, "stable-relationship", null, "registration"]],
          },
          {
            name: "discovery_contact",
            columns: ["registration_id", "session_id", "persona_id"],
            rows: [["registration", "ses_deleted_by_rebuild", persona.id]],
          },
        ],
      });
      yield* runSharedLifeCutover(client, {
        directory: root,
        archive,
        application,
        personas,
        confirmation: "yes",
      });
      const moved = yield* client.session.get({ sessionID: session.id });
      expect(moved.location.directory).toBe(`${root}/personas/${persona.id}`);
      const after = yield* client.session.export({ sessionID: session.id, sanitize: false });
      expect(after.messages.slice(0, native.messages.length)).toEqual(native.messages);
      const snapshot = yield* client
        .rpc(sessionFolders)
        .read({ folderID: session.id }, { location: { directory: root } });
      expect(snapshot.runtime?.state).toMatchObject({ mood: 41, energy: 42 });
      expect(snapshot.runtime?.state).not.toHaveProperty("affection");
      expect(snapshot.runtime?.shortTerm).not.toContain("private name");
      expect(snapshot.relationship?.state).toEqual({ affection: 91 });
      expect(snapshot.relationship?.shortTerm).toBe("The user's private name and promise");
      expect(snapshot.relationship?.additional["trust"]?.value).toBe(8);
      expect(snapshot.binding?.conversationKey).toBe("stable-relationship");
      // Retrying the same paused cutover must preserve both the native session and files.
      yield* runSharedLifeCutover(client, {
        directory: root,
        archive,
        application,
        personas,
        confirmation: "yes",
      });
      expect((yield* client.session.get({ sessionID: session.id })).id).toBe(session.id);
    }),
  ));

test("cutover retains ended and reset relationships without publishing their State or private provenance", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const ended = yield* legacySession(client, root);
      const retained = yield* legacySession(client, root);
      const persona = personas.get("persona1")!;
      const entries = [ended, retained].map((info) => ({
        info: Schema.encodeSync(Session.Info)(info),
        pending: [],
        folder: {
          ...renderSnapshot(persona, "old"),
          runtime: {
            state: {
              mood: 1,
              energy: 2,
              stress: 3,
              connection: 4,
              solitude: 5,
              affection: 6,
              traits: {},
            },
            stateChange: {
              source: "msg_private_user",
              reason: "a private explanation",
              at: "2026-10-22T00:00:00Z",
            },
            additional: {},
            shortTerm: "A private promise",
            longTerm: [],
            receipts: { repeated_call: { operation: "dice", inputHash: "hash", output: "123" } },
          },
        },
      }));
      const application = JSON.stringify({
        version: 1,
        tables: [
          {
            name: "conversation",
            columns: ["session_id", "persona_id", "usage_key", "ended_at"],
            rows: [[ended.id, persona.id, "ended-key", 1]],
          },
          { name: "retained_session", columns: ["session_id"], rows: [[retained.id]] },
          {
            name: "usage_session",
            columns: ["session_id", "persona_id", "conversation_key"],
            rows: [
              [retained.id, persona.id, "retained-key"],
              [ended.id, persona.id, "ended-key"],
            ],
          },
        ],
      });
      yield* runSharedLifeCutover(client, {
        directory: root,
        archive: JSON.stringify({ version: 1, sessions: entries }),
        application,
        personas,
        confirmation: "yes",
      });
      for (const [info, key] of [
        [ended, "ended-key"],
        [retained, "retained-key"],
      ] as const) {
        const result = yield* client
          .rpc(sessionFolders)
          .read({ folderID: info.id }, { location: { directory: root } });
        expect(result.binding).toMatchObject({ conversationKey: key, writable: false });
        expect(result.relationship?.state?.mood).toBe(1);
        expect(result.relationship?.stateChange?.reason).toBe("a private explanation");
        expect(JSON.stringify(result.runtime)).not.toContain("private");
        expect(result.runtime?.receipts[`${info.id}:repeated_call`]?.output).toBe("123");
      }
    }),
  ));

test.each([
  "unconfirmed",
  "invalid",
  "missing-session",
  "missing-persona",
  "wrong-persona",
  "wrong-binding",
  "duplicate",
  "foreign-source",
  "archived-queue",
  "rebuilding",
] as const)(
  "cutover rejects %s before changing native locations and logs no archive content",
  (failure) =>
    withTransferClient(({ client, root, personas, calls }) =>
      Effect.gen(function* () {
        const session = yield* legacySession(client, root);
        if (failure === "archived-queue")
          yield* client.session.prompt({
            sessionID: session.id,
            text: "private pending input",
            resume: false,
          });
        const pending = yield* client.session.inbox.list({ sessionID: session.id });
        const persona = personas.get("persona1")!;
        const entry = {
          info: {
            ...Schema.encodeSync(Session.Info)(session),
            ...(failure === "foreign-source" && {
              location: { directory: "/private/unrelated-project" },
            }),
          },
          pending: pending.map((item) => Schema.encodeSync(SessionInbox.Info)(item)),
          folder: {
            ...renderSnapshot(persona, "private-cutover-marker"),
            ...(failure === "wrong-persona" && {
              persona: { ...renderSnapshot(persona, "").persona, id: "other" },
            }),
          },
        };
        const archive =
          failure === "invalid"
            ? "private-invalid-json"
            : JSON.stringify({
                version: 1,
                sessions: failure === "duplicate" ? [entry, entry] : [entry],
              });
        const application = cutoverApplication(failure, session, persona);
        const events: ContactDiagnostic[] = [];
        calls.length = 0;
        const error = yield* runSharedLifeCutover(client, {
          directory: root,
          archive,
          application,
          personas: failure === "missing-persona" ? new Map() : personas,
          confirmation: failure === "unconfirmed" ? undefined : "yes",
          log: (event) => events.push(event),
        }).pipe(Effect.flip);
        expect(error.message).toContain("Shared-life cutover failed");
        expect(calls.every((call) => call.method === "GET")).toBe(true);
        expect((yield* client.session.get({ sessionID: session.id })).location.directory).toBe(
          root,
        );
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({
          requestId: events[0]!.requestId,
          stage: "preflight",
          outcome: "failed",
          code: "SHARED_LIFE_CUTOVER_FAILED",
        });
        expect(JSON.stringify(events)).not.toContain("private-cutover-marker");
        expect(JSON.stringify(events)).not.toContain("private-invalid-json");
      }),
    ),
);

test("cutover preserves a prepared contact's key and archives an unbound native session", () =>
  withTransferClient(({ client, root, personas }) =>
    Effect.gen(function* () {
      const contact = yield* legacySession(client, root);
      const unbound = yield* legacySession(client, root);
      const persona = personas.get("persona1")!;
      const sessions = archivedSessions([contact, unbound], persona);
      const application = JSON.stringify({
        version: 1,
        tables: [
          {
            name: "discovery_contact",
            columns: ["session_id", "persona_id"],
            rows: [
              [null, persona.id],
              [contact.id, persona.id],
            ],
          },
          {
            name: "usage_session",
            columns: ["session_id", "persona_id", "conversation_key"],
            rows: [["ses_deleted", persona.id, "deleted"]],
          },
        ],
      });
      yield* runSharedLifeCutover(client, {
        directory: root,
        archive: JSON.stringify({ version: 1, sessions }),
        application,
        personas,
        confirmation: "yes",
      });
      for (const info of [contact, unbound]) {
        const result = yield* client
          .rpc(sessionFolders)
          .read({ folderID: info.id }, { location: { directory: root } });
        expect(result.binding).toMatchObject({
          conversationKey: info.id,
          writable: info.id === contact.id,
        });
        expect(result.runtime?.shortTerm).toBe(persona.initial?.memory ?? "");
        expect(result.relationship?.shortTerm).toBe("");
      }
    }),
  ));

test.each(["duplicate-relation", "two-active"] as const)(
  "cutover rejects ambiguous ownership (%s) before writing",
  (failure) =>
    withTransferClient(({ client, root, personas, calls }) =>
      Effect.gen(function* () {
        const first = yield* legacySession(client, root);
        const second = yield* legacySession(client, root);
        const persona = personas.get("persona1")!;
        const sessions = archivedSessions([first, second], persona);
        const application = JSON.stringify({
          version: 1,
          tables: [
            {
              name: "conversation",
              columns: ["session_id", "persona_id", "usage_key", "ended_at"],
              rows: [
                [first.id, persona.id, "first-key", null],
                [
                  second.id,
                  persona.id,
                  failure === "duplicate-relation" ? "first-key" : "second-key",
                  null,
                ],
              ],
            },
          ],
        });
        calls.length = 0;
        const error = yield* runSharedLifeCutover(client, {
          directory: root,
          archive: JSON.stringify({ version: 1, sessions }),
          application,
          personas,
          confirmation: "yes",
          log: () => {},
        }).pipe(Effect.flip);
        expect(error.message).toContain("Shared-life cutover failed");
        expect(calls.every((call) => call.method === "GET")).toBe(true);
      }),
    ),
);
