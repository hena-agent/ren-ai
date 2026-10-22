import { Effect, Schema, Stream } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";
import { sessionArchive } from "./transfer-format.ts";
import { remoteHost } from "./remote.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";

test("failed folder RPCs preserve write access and Relationship data until an explicit successful removal", () =>
  withRemoteHost((remote, _directory, { transport }) =>
    Effect.gen(function* () {
      const first = yield* remote.createSession("persona1");
      const sibling = yield* remote.createSession("persona1");
      const path = join(first.location.directory, "conversations", first.id);
      const forward = transport.fetch;
      transport.fetch = (request) =>
        request.method === "POST"
          ? Promise.resolve(new Response("Unavailable", { status: 503 }))
          : forward(request);
      expect(yield* remote.sessions.writable(first.id, false).pipe(Effect.flip)).toBeInstanceOf(
        Error,
      );
      expect(
        yield* remote.sessions.removeRelationship("persona1", first.id).pipe(Effect.flip),
      ).toBeInstanceOf(Error);
      expect(
        (yield* Effect.promise(() => readSessionBinding(first.location.directory, first.id)))
          .writable,
      ).toBe(true);
      expect((yield* Effect.promise(() => stat(path))).isDirectory()).toBe(true);
      transport.fetch = forward;
      yield* remote.sessions.remove(first.id);
      yield* remote.sessions.removeRelationship("persona1", first.id);
      yield* Effect.promise(async () => {
        await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      });
      expect(
        (yield* Effect.promise(() =>
          stat(join(sibling.location.directory, "conversations", sibling.id)),
        )).isDirectory(),
      ).toBe(true);
      expect((yield* remote.sessions.get(sibling.id)).location.directory).toBe(
        first.location.directory,
      );
    }),
  ));

test("missing-session errors retain the native diagnostic for the operator", () =>
  withRemoteHost((remote, directory, { transport }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.remove(session.id);
      const native = yield* remote.client.session.get({ sessionID: session.id }).pipe(Effect.flip);
      const reported = yield* remote.sessions.get(session.id).pipe(Effect.flip);
      expect(reported.message).toBe(native.message);
      expect(reported.message).not.toBe("");
      const rejected = yield* remote.sessions
        .prompt({ sessionID: session.id, text: "missing" })
        .pipe(Effect.flip);
      expect(rejected).toMatchObject({ _tag: "Session.NotFoundError" });
      const cause = new Error("Cannot persist turn probe");
      const guarded = yield* remoteHost(
        {
          baseUrl: "https://oc.test",
          authorization: "Basic test",
          directory,
          model: "test/probe",
          groundRules: "",
          onPrompt: () => Effect.fail(cause),
        },
        remote.personas,
      ).pipe(Effect.provide(FetchHttpClient.layer));
      const before = transport.requests.length;
      expect(
        yield* guarded.sessions
          .prompt({ sessionID: session.id, text: "must not be admitted" })
          .pipe(Effect.flip),
      ).toBe(cause);
      expect(transport.requests).toHaveLength(before);
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
        ...data,
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
          ...data,
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
