import { Effect, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { withRemoteHost, replaceCheckpoint } from "../../test/remote-host.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";
import { Session } from "@opencode/schema/session";
import type { SessionInbox } from "@opencode/schema/session-inbox";
import { SessionMessage } from "@opencode/schema/session-message";

test.each(["user", "synthetic"] as const)(
  "migration preserves a promoted %s before an assistant exists",
  (kind) =>
    withRemoteHost((remote, directory) =>
      Effect.gen(function* () {
        const session = yield* remote.createSession("persona1");
        const message = {
          type: kind,
          id: SessionMessage.ID.make("msg_promoted_input"),
          text: "promoted work",
          time: { created: session.time.created },
        };
        yield* replaceCheckpoint(remote, { info: session, messages: [message] });
        const first = yield* exportSessions(remote.client, [session.id]);
        const second = yield* exportSessions(remote.client, [session.id]);
        expect(Schema.decodeUnknownSync(sessionArchive)(first).sessions[0]?.recovery).toEqual({
          id: "msg_cutover_msg_promoted_input",
          tools: [],
        });
        expect(second).toBe(first);
        yield* remote.sessions.remove(session.id);
        yield* restoreSessions(remote.client, first, directory);
        yield* remote.retry(session.id);
        yield* remote.sessions.wait(session.id);
        expect(
          JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id })),
        ).toContain("preserved memory");
      }),
    ),
);

test("a promoted input with an unfinished assistant resumes after migration", () =>
  withRemoteHost((remote, directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const gate = yield* llm.gate();
      yield* remote.sessions.prompt({ sessionID: session.id, text: "the in-flight user request" });
      yield* gate.started;
      expect(yield* remote.sessions.inbox(session.id)).toEqual([]);
      const contents = yield* exportSessions(remote.client, [session.id]);
      const saved = Schema.decodeUnknownSync(sessionArchive)(contents).sessions[0]!;
      expect(saved.messages.some((message) => message.type === "assistant")).toBe(false);
      yield* remote.sessions.interrupt(session.id);
      yield* gate.release;
      yield* remote.sessions.wait(session.id);
      yield* remote.sessions.remove(session.id);
      yield* restoreSessions(remote.client, contents, directory);
      expect(yield* remote.sessions.inbox(session.id)).toHaveLength(1);
      yield* llm.serve(() => TestLLM.text("recovered in-flight work", "answer"));
      yield* remote.retry(session.id);
      yield* remote.sessions.wait(session.id);
      const history = JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id }));
      expect(history).toContain("the in-flight user request");
      expect(history).toContain("recovered in-flight work");
    }),
  ));

test("a corrupt cyclic archive cannot partially import an unrelated valid session", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const good = yield* remote.createSession("persona1");
      const left = yield* remote.createSession("persona1");
      const right = yield* remote.createSession("persona1");
      const contents = yield* exportSessions(remote.client, [good.id, left.id, right.id]);
      const decoded = Schema.decodeUnknownSync(sessionArchive)(contents);
      const cyclic = Schema.encodeSync(sessionArchive)({
        ...decoded,
        sessions: decoded.sessions.map((entry) => ({
          ...entry,
          info:
            entry.info.id === good.id
              ? entry.info
              : { ...entry.info, parentID: entry.info.id === left.id ? right.id : left.id },
        })),
      });
      for (const session of [good, left, right]) yield* remote.sessions.remove(session.id);
      expect(
        (yield* restoreSessions(remote.client, cyclic, directory).pipe(Effect.flip)).message,
      ).toContain("Cyclic session parents");
      expect(
        yield* remote.sessions
          .get(good.id)
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed("not imported"))),
      ).toBe("not imported");
    }),
  ));

test("fork state requires a full-volume restore instead of silently losing native metadata", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const parent = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: parent.id, text: "parent memory" });
      yield* remote.sessions.wait(parent.id);
      const child = yield* remote.client.session.fork({ sessionID: parent.id });
      const unrelated = yield* remote.createSession("persona1");
      yield* remote.sessions.rename({ sessionID: unrelated.id, title: "unrelated session" });
      const contents = yield* exportSessions(remote.client, [child.id, parent.id]);
      yield* remote.sessions.remove(child.id);
      yield* remote.sessions.remove(parent.id);
      expect(
        (yield* restoreSessions(remote.client, contents, directory).pipe(Effect.flip)).message,
      ).toContain("full OpenCode volume restore");
      expect(
        yield* remote.sessions
          .get(child.id)
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed("not imported"))),
      ).toBe("not imported");
      expect((yield* remote.sessions.get(unrelated.id)).title).toBe("unrelated session");
    }),
  ));

test("a child archive imports its parent first", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const parent = yield* remote.createSession("persona1");
      const child = yield* remote.createSession("persona1");
      const original = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, [child.id]),
      ).sessions[0]!;
      yield* replaceCheckpoint(remote, {
        messages: original.messages,
        info: { ...original.info, parentID: parent.id },
      });
      const contents = yield* exportSessions(remote.client, [child.id, parent.id]);
      yield* remote.sessions.remove(child.id);
      yield* remote.sessions.remove(parent.id);
      yield* restoreSessions(remote.client, contents, directory);
      expect((yield* remote.sessions.get(child.id)).parentID).toBe(parent.id);
    }),
  ));

test("duplicate sessions and pending control work are rejected before changing the destination", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "pending", resume: false });
      const archive = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, [session.id]),
      );
      const entry = archive.sessions[0]!;
      const duplicate = Schema.encodeSync(sessionArchive)({ version: 1, sessions: [entry, entry] });
      expect(
        (yield* restoreSessions(remote.client, duplicate, directory).pipe(Effect.flip)).message,
      ).toContain("Duplicate session in archive");
      const control: SessionInbox.Compaction = {
        ...entry.pending[0]!,
        type: "compaction",
        payload: {},
      };
      yield* remote.sessions.remove(session.id);
      const pendingControl = Schema.encodeSync(sessionArchive)({
        version: 1,
        sessions: [{ ...entry, pending: [control] }],
      });
      expect(
        (yield* restoreSessions(remote.client, pendingControl, directory).pipe(Effect.flip))
          .message,
      ).toContain("Drain pending control operations");
      expect(
        yield* remote.sessions
          .get(session.id)
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed("absent"))),
      ).toBe("absent");
      expect(yield* exportSessions(remote.client, [session.id]).pipe(Effect.flip)).toBeInstanceOf(
        Error,
      );
      expect((yield* remote.createSession("missing").pipe(Effect.flip)).message).toBe(
        "Unknown persona: missing",
      );
      expect(
        yield* restoreSessions(remote.client, '{"version":2,"sessions":[]}', directory).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(Error);
    }),
  ));

test("queued attachments and synthetic work survive relocation without reading the old host's files", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({
        sessionID: session.id,
        text: "see @ here",
        resume: false,
        files: [
          {
            uri: "data:text/plain;base64,YWJj",
            name: "memo.txt",
            description: "a note",
            mention: { start: 4, end: 5, text: "@" },
          },
        ],
      });
      yield* remote.client.session.synthetic({
        sessionID: session.id,
        text: "scheduled work",
        description: "follow-up",
        resume: false,
        delivery: "queue",
      });
      const contents = yield* exportSessions(remote.client, [session.id]);
      yield* remote.sessions.remove(session.id);
      yield* restoreSessions(remote.client, contents, directory);
      const pending = yield* remote.sessions.inbox(session.id);
      expect(pending).toHaveLength(2);
      expect(pending.find((item) => item.type === "user")?.payload.files?.[0]).toMatchObject({
        data: "YWJj",
        mime: "text/plain",
        name: "memo.txt",
        description: "a note",
        mention: { start: 4, end: 5, text: "@" },
      });
      expect(pending.find((item) => item.type === "synthetic")?.payload).toMatchObject({
        text: "scheduled work",
        description: "follow-up",
      });
      expect((yield* remote.sessions.get(Session.ID.make(session.id))).id).toBe(session.id);
    }),
  ));
