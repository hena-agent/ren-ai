import { Effect, Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { Agent } from "@opencode/schema";
import { expect, test } from "vitest";
import {
  withRemoteHost,
  pausedRestore,
  exportedArchive,
} from "../../test/remote-host.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

const createdArchive = (remote: Parameters<typeof exportedArchive>[0]) =>
  Effect.gen(function* () {
    const session = yield* remote.createSession("persona1");
    const archive = yield* exportedArchive(remote, [session.id]);
    return { session, archive };
  });

test("a snapshot for another persona rejects the entire archive before any folder or session is written", () =>
  withRemoteHost((remote, directory, { transport }) =>
    Effect.gen(function* () {
      const first = yield* remote.createSession("persona1");
      const second = yield* remote.createSession("persona1");
      const archive = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, [first.id, second.id]),
      );
      const malformed = Schema.encodeSync(sessionArchive)({
        ...archive,
        sessions: archive.sessions.map((entry) =>
          entry.info.id === second.id
            ? {
                ...entry,
                folder: { ...entry.folder, persona: { ...entry.folder.persona, id: "another" } },
              }
            : entry,
        ),
      });
      yield* remote.sessions.remove(first.id);
      yield* remote.sessions.remove(second.id);
      transport.requests.length = 0;
      expect(
        (yield* restoreSessions(remote.client, malformed, directory).pipe(Effect.flip)).message,
      ).toContain("Snapshot persona does not match session agent");
      expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
      expect(
        yield* remote.client.session
          .get({ sessionID: first.id })
          .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed("absent"))),
      ).toBe("absent");
    }),
  ));

test("a later target collision rejects the whole archive before any earlier session is imported", () =>
  withRemoteHost((remote, directory, { transport }) =>
    Effect.gen(function* () {
      const first = yield* remote.createSession("persona1");
      const collision = yield* remote.createSession("persona1");
      yield* remote.sessions.rename({
        sessionID: collision.id,
        title: "existing operator evidence",
      });
      const contents = yield* exportSessions(remote.client, [first.id, collision.id]);
      yield* remote.sessions.remove(first.id);
      transport.requests.length = 0;
      expect(
        (yield* restoreSessions(remote.client, contents, directory).pipe(Effect.flip)).message,
      ).toContain("already exists");
      expect(transport.requests.every((request) => request.method === "GET")).toBe(true);
      expect(
        yield* remote.sessions
          .get(first.id)
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed("absent"))),
      ).toBe("absent");
      expect((yield* remote.sessions.get(collision.id)).title).toBe("existing operator evidence");
    }),
  ));

test.each([{ tools: [] }, { id: "msg_journal", tools: [{}] }])(
  "malformed recovery journal is rejected before reaching OpenCode (%j)",
  (recovery) =>
    withRemoteHost((remote, directory, { transport }) =>
      Effect.gen(function* () {
        const { session, archive } = yield* createdArchive(remote);
        const malformed = JSON.stringify({
          ...archive,
          sessions: [
            {
              ...archive.sessions[0],
              info: Schema.encodeSync(Session.Info)(session),
              messages: [],
              pending: [],
              recovery,
            },
          ],
        });
        yield* remote.sessions.remove(session.id);
        transport.requests.length = 0;
        expect(
          (yield* restoreSessions(remote.client, malformed, directory).pipe(Effect.flip)).message,
        ).toBe("Invalid private session archive");
        expect(transport.requests).toEqual([]);
      }),
    ),
);

test.each(["user", "synthetic"] as const)(
  "restored %s inputs remain paused without calling the model",
  (kind) =>
    withRemoteHost((remote, directory, { llm }) =>
      Effect.gen(function* () {
        const session = yield* remote.createSession("persona1");
        const input = {
          sessionID: session.id,
          text: "work after verification",
          resume: false,
          delivery: "queue" as const,
        };
        if (kind === "user") yield* remote.sessions.prompt(input);
        else yield* remote.client.session.synthetic(input);
        const contents = yield* exportSessions(remote.client, [session.id]);
        yield* remote.sessions.remove(session.id);
        yield* pausedRestore(remote, llm, contents, directory);
        expect((yield* remote.sessions.inbox(session.id)).map((item) => item.type)).toEqual([kind]);
      }),
    ),
);

test("invalid scope inventory rejects the whole archive before any native or folder mutation", () =>
  withRemoteHost((remote, directory, { transport }) =>
    Effect.gen(function* () {
      const { session, archive } = yield* createdArchive(remote);
      const folder = archive.personas[0]!;
      const entry = archive.sessions[0]!;
      const binding = folder.bindings[session.id]!;
      const cases = [
        {
          archive: { ...archive, personas: [folder, folder] },
        },
        {
          archive: { ...archive, personas: [folder, { ...folder, sandboxID: "ses_duplicate" }] },
        },
        {
          archive: {
            ...archive,
            personas: [
              { ...folder, bindings: { [session.id]: { ...binding, personaID: "other" } } },
            ],
          },
        },
        {
          archive: { ...archive, personas: [{ ...folder, relationships: {} }] },
        },
        {
          archive: {
            ...archive,
            sessions: [
              {
                ...entry,
                info: { ...entry.info, agent: Agent.ID.make("other") },
                folder: { ...entry.folder, persona: { ...entry.folder.persona, id: "other" } },
              },
            ],
          },
        },
        {
          archive: {
            ...archive,
            sessions: [
              {
                ...entry,
                folder: {
                  ...entry.folder,
                  binding: { ...binding, conversationKey: "wrong-relationship" },
                },
              },
            ],
          },
        },
        {
          archive: { ...archive, personas: [] },
        },
      ];
      for (const invalid of cases) {
        transport.requests.length = 0;
        const rejected = yield* restoreSessions(
          remote.client,
          Schema.encodeSync(sessionArchive)(invalid.archive),
          directory,
        ).pipe(Effect.flip);
        expect(rejected).toBeInstanceOf(Error);
        expect(transport.requests).toEqual([]);
      }
      expect(yield* exportedArchive(remote, [session.id])).toEqual(archive);
    }),
  ));
