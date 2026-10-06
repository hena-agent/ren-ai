import { Effect, Schema, Scope } from "effect";
import { expect, test } from "vitest";
import {
  withRemoteHost,
  exportedSession,
  pausedRestore,
  replaceCheckpoint,
  promotedCheckpoint,
} from "../../test/remote-host.test-helper.ts";
import { SessionMessage } from "@opencode/schema/session-message";
import { AbsolutePath } from "@opencode/schema";
import { exportSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test("a turn completed between backup reads must not manufacture recovery for its earlier input", () =>
  withRemoteHost((remote, _directory, { transport }) =>
    Effect.gen(function* () {
      const { session } = yield* promotedCheckpoint(
        remote,
        SessionMessage.ID.make("msg_backing_up_input"),
        "complete this work",
      );
      const fetch = transport.fetch;
      let completed = false;
      transport.fetch = async (request) => {
        if (!completed && new URL(request.url).pathname.endsWith("/export")) {
          completed = true;
          await Effect.runPromise(
            remote.client.session.synthetic({
              sessionID: session.id,
              text: "finish the promoted work",
            }),
          );
          await Effect.runPromise(remote.sessions.wait(session.id));
        }
        return fetch(request);
      };
      const archived = yield* exportedSession(remote, session.id);
      expect(completed).toBe(true);
      expect(archived.messages.at(-1)?.type).toBe("idle");
      expect(archived.messages.length).toBeGreaterThan(2);
      expect(archived.recovery).toBeUndefined();
    }),
  ));

test("a settled assistant without an idle marker does not manufacture recovery work", () =>
  withRemoteHost((remote) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "settled conversation" });
      yield* remote.sessions.wait(session.id);
      const saved = yield* exportedSession(remote, session.id);
      yield* replaceCheckpoint(remote, {
        info: saved.info,
        messages: saved.messages.filter((message) => message.type !== "idle"),
      });
      const native = yield* remote.client.session.export({
        sessionID: session.id,
        sanitize: false,
      });
      expect(native.messages.at(-1)?.type).toBe("assistant");
      const archived = yield* exportedSession(remote, session.id);
      expect(archived.recovery).toBeUndefined();
      expect(archived.messages).toEqual(native.messages);
    }),
  ));

test("an active native shell can be exported before any settled history exists", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const session = yield* remote.client.session.create({
        location: { directory: AbsolutePath.make(directory) },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      yield* Effect.forkIn(
        remote.client.session.shell({ sessionID: session.id, command: "sleep 30" }),
        yield* Scope.Scope,
      );
      yield* Effect.gen(function* () {
        for (;;) {
          const [last] = (yield* remote.client.message.list({
            sessionID: session.id,
            order: "desc",
            limit: 1,
          })).data;
          if (last?.type === "shell" && last.status === "running") return;
          yield* Effect.sleep("10 millis");
        }
      }).pipe(Effect.timeout("3 seconds"));
      const archived = yield* exportedSession(remote, session.id);
      expect(archived.messages).toEqual([]);
      expect(archived.recovery?.tools).toEqual([]);
      yield* remote.sessions.interrupt(session.id);
      yield* remote.sessions.wait(session.id);
    }),
  ));

test("the recovery journal and wake instruction exist before any restored work executes", () =>
  withRemoteHost((remote, directory, { llm }) =>
    Effect.gen(function* () {
      const { session } = yield* promotedCheckpoint(
        remote,
        SessionMessage.ID.make("msg_waiting_recovery"),
        "promoted work",
      );
      const contents = yield* exportSessions(remote.client, [session.id]);
      const archived = Schema.decodeUnknownSync(sessionArchive)(contents).sessions[0]!;
      yield* remote.sessions.remove(session.id);
      yield* pausedRestore(remote, llm, contents, directory);
      const pending = yield* remote.sessions.inbox(session.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.type === "synthetic" && pending[0].payload.text).toContain(
        "preserved history and recorded tool effects",
      );
      const journal = yield* remote.sessions.messages({ sessionID: session.id, type: "synthetic" });
      expect(journal.map((message) => message.id)).toEqual([archived.recovery!.id]);
    }),
  ));
