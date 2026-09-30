import { Effect, Schema, Stream } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";

test("missing-session errors retain the native diagnostic for the operator", () =>
  withRemoteHost((remote) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.remove(session.id);
      const native = yield* remote.client.session.get({ sessionID: session.id }).pipe(Effect.flip);
      const reported = yield* remote.sessions.get(session.id).pipe(Effect.flip);
      expect(reported.message).toBe(native.message);
      expect(reported.message).not.toBe("");
    }),
  ));

test("an OpenCode outage is not mistaken for a missing session", () =>
  withRemoteHost((remote, _directory, { transport }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      transport.fetch = () => Promise.resolve(new Response("offline", { status: 503 }));
      const failure = yield* remote.sessions.get(session.id).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.succeed("wrongly missing")),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((yield* remote.outcomes.pipe(Stream.runDrain, Effect.flip)).message).toBe(
        "OpenCode event stream disconnected",
      );
    }),
  ));

test("recovery leaves an empty session alone and can recover a failure before any assistant message", () =>
  withRemoteHost((remote, directory) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.retry(session.id);
      expect(yield* remote.sessions.messages({ sessionID: session.id })).toEqual([]);
      const data = Schema.decodeUnknownSync(sessionArchive)(
        yield* exportSessions(remote.client, [session.id]),
      );
      const entry = data.sessions[0]!;
      const failure = Schema.encodeSync(sessionArchive)({
        version: 1,
        sessions: [
          {
            ...entry,
            info: {
              ...entry.info,
              outcome: "failed",
              time: { ...entry.info.time, idle: entry.info.time.created },
            },
          },
        ],
      });
      yield* remote.sessions.remove(session.id);
      yield* restoreSessions(remote.client, failure, directory);
      yield* remote.retry(session.id);
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      expect(JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id }))).toContain(
        "preserved memory",
      );
    }),
  ));

test.each([false, true])(
  "restored assistant outcomes drive recovery when idle metadata is absent (failed: %s)",
  (failed) =>
    withRemoteHost((remote, directory, { llm }) =>
      Effect.gen(function* () {
        yield* llm.serve(() =>
          failed ? providerUnavailable("offline") : TestLLM.text("prior answer", "answer"),
        );
        const session = yield* remote.createSession("persona1");
        yield* remote.sessions.prompt({ sessionID: session.id, text: "remember this" });
        yield* remote.sessions.wait(session.id);
        const data = Schema.decodeUnknownSync(sessionArchive)(
          yield* exportSessions(remote.client, [session.id]),
        );
        const entry = data.sessions[0]!;
        const contents = Schema.encodeSync(sessionArchive)({
          version: 1,
          sessions: [
            {
              ...entry,
              info: {
                ...entry.info,
                time: { created: entry.info.time.created, updated: entry.info.time.updated },
              },
            },
          ],
        });
        yield* remote.sessions.remove(session.id);
        yield* restoreSessions(remote.client, contents, directory);
        expect((yield* remote.sessions.get(session.id)).outcome).toBeUndefined();
        yield* llm.serve(() => TestLLM.text("recovered answer", "answer"));
        yield* remote.retry(session.id);
        yield* remote.sessions.wait(session.id);
        const history = JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id }));
        expect(history.includes("recovered answer")).toBe(failed);
      }),
    ),
);
