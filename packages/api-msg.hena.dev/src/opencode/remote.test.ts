import { rm } from "node:fs/promises";
import { Effect, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { messagingFixture } from "../../test/messaging.test-helper.ts";
import {
  scriptedPersona,
  providerUnavailable,
  standaloneTestHost,
} from "../../test/messaging-host.test-helper.ts";
import { remoteHost } from "./remote.ts";
import { exportSessions, restoreSessions } from "./transfer.ts";

test("persona sessions are operated through the public OpenCode API", async () => {
  const { root, personaDirectory } = await messagingFixture("remote-host-");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() => TestLLM.text("remote reply", "answer"));
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          const remote = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Basic machine",
              directory: personaDirectory,
              model: "test/probe",
            },
            native.personas,
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
              const request = new Request(input, init);
              expect(request.headers.get("authorization")).toBe("Basic machine");
              return native.web(request);
            }),
          );
          const connection = yield* remote.outcomes.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("2 seconds"),
          );
          expect(connection[0]?.type).toBe("server.connected");
          const unrelated = yield* remote.client.agent.list({ location: { directory: root } });
          expect(
            unrelated.data.find((agent) => agent.id === "persona1")?.system ?? "",
          ).not.toContain("You are Persona1");
          const session = yield* remote.createSession("persona1");
          const expectReply = (text: string) =>
            Effect.gen(function* () {
              yield* remote.sessions.wait(session.id);
              expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
              const messages = yield* remote.sessions.messages({ sessionID: session.id });
              expect(JSON.stringify(messages)).toContain(text);
              return messages;
            });
          yield* remote.sessions.prompt({ sessionID: session.id, text: "hello" });
          yield* expectReply("remote reply");
          yield* remote.sessions.rename({ sessionID: session.id, title: "operator title" });
          expect((yield* remote.sessions.get(session.id)).title).toBe("operator title");
          yield* llm.serve(() => providerUnavailable("offline"));
          yield* remote.sessions.prompt({ sessionID: session.id, text: "retry this" });
          yield* remote.sessions.wait(session.id);
          expect((yield* remote.sessions.get(session.id)).outcome).toBe("failed");
          yield* llm.serve(() => TestLLM.text("recovered", "answer"));
          yield* remote.retry(session.id);
          const completed = yield* expectReply("recovered");
          yield* remote.retry(session.id);
          expect(yield* remote.sessions.messages({ sessionID: session.id })).toEqual(completed);
          yield* remote.sessions.prompt({ sessionID: session.id, text: "queued", resume: false });
          const pending = yield* remote.sessions.inbox(session.id);
          expect(pending).toHaveLength(1);
          const archive = yield* exportSessions(remote.client, [session.id]);
          expect(
            (yield* restoreSessions(remote.client, archive, personaDirectory).pipe(Effect.flip))
              .message,
          ).toContain("already exists");
          yield* remote.sessions.cancelInbox({ sessionID: session.id, inboxID: pending[0]!.id });
          expect(yield* remote.sessions.inbox(session.id)).toEqual([]);
          yield* remote.sessions.interrupt(session.id);
          yield* remote.sessions.remove(session.id);
          expect(
            yield* remote.sessions
              .get(session.id)
              .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed("missing"))),
          ).toBe("missing");
          yield* restoreSessions(remote.client, archive, personaDirectory);
          expect((yield* remote.sessions.get(session.id)).title).toBe("operator title");
          expect(
            JSON.stringify(yield* remote.sessions.messages({ sessionID: session.id })),
          ).toContain("recovered");
          const restoredPending = yield* remote.sessions.inbox(session.id);
          expect(restoredPending.map((item) => item.id)).toEqual([pending[0]!.id]);
          yield* remote.retry(session.id);
          yield* remote.sessions.wait(session.id);
          expect(yield* remote.sessions.inbox(session.id)).toEqual([]);
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
