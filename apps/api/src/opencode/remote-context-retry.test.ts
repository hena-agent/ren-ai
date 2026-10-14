import { Deferred, Effect } from "effect";
import { Plugin } from "@opencode/plugin/effect";
import { expect, test } from "vitest";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";
import { TestLLM } from "@opencode/ai/testing";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";

test("distinct pre-assistant context failures get fresh retries without losing their prior assistant", () =>
  withRemoteHost((remote, _directory, { llm, registerPlugin }) =>
    Effect.gen(function* () {
      let failures = 0;
      yield* registerPlugin(
        Plugin.define({
          id: "temporary-context-outage",
          effect: (ctx) =>
            ctx.session.hook("context", () =>
              Effect.gen(function* () {
                if (failures > 0) {
                  failures--;
                  yield* Effect.die(new Error("context callback SQL unavailable"));
                }
              }),
            ),
        }),
      );
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "preserve this prior answer" });
      yield* remote.sessions.wait(session.id);
      const [prior] = yield* remote.sessions.messages({
        sessionID: session.id,
        type: "assistant",
        limit: 1,
      });
      const before = (yield* llm.requests()).length;
      failures = 2;
      yield* remote.sessions.prompt({ sessionID: session.id, text: "resume this conversation" });
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("failed");
      yield* remote.retry(session.id);
      yield* remote.sessions.wait(session.id);
      expect(failures).toBe(0);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("failed");
      const [unchanged] = yield* remote.sessions.messages({
        sessionID: session.id,
        type: "assistant",
        limit: 1,
      });
      expect(unchanged?.id).toBe(prior?.id);
      expect(yield* llm.requests()).toHaveLength(before);
      yield* remote.retry(session.id);
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      expect(yield* llm.requests()).toHaveLength(before + 1);
    }),
  ));

test("retrying a lost acknowledgement reuses the same failed checkpoint while context is still preparing", () =>
  withRemoteHost((remote, _directory, { llm, registerPlugin, transport }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      let blocked = false;
      yield* registerPlugin(
        Plugin.define({
          id: "hold-retry-context",
          effect: (ctx) =>
            ctx.session.hook("context", () =>
              Effect.gen(function* () {
                if (blocked) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
              }),
            ),
        }),
      );
      const session = yield* remote.createSession("persona1");
      yield* llm.serve(() => providerUnavailable("initial provider failure"));
      yield* remote.sessions.prompt({ sessionID: session.id, text: "retry once safely" });
      yield* remote.sessions.wait(session.id);
      const [checkpoint] = yield* remote.sessions.messages({
        sessionID: session.id,
        order: "desc",
        limit: 1,
      });
      expect(checkpoint?.type).toBe("idle");
      yield* llm.serve(() => TestLLM.text("recovered once", "answer"));
      blocked = true;
      const forward = transport.fetch;
      let loseAcknowledgement = true;
      transport.fetch = async (request) => {
        const response = await forward(request);
        if (loseAcknowledgement && new URL(request.url).pathname.endsWith("/synthetic")) {
          loseAcknowledgement = false;
          await response.arrayBuffer();
          return new Response("acknowledgement lost", { status: 503 });
        }
        return response;
      };
      expect(yield* remote.retry(session.id).pipe(Effect.flip)).toBeInstanceOf(Error);
      yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));
      yield* remote.retry(session.id);
      const synthetic = yield* remote.sessions.messages({
        sessionID: session.id,
        type: "synthetic",
      });
      expect(synthetic).toHaveLength(1);
      expect(synthetic[0]!.id.length).toBeLessThanOrEqual(100);
      yield* Deferred.succeed(release, undefined);
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      const assistants = yield* remote.sessions.messages({
        sessionID: session.id,
        type: "assistant",
      });
      expect(assistants).toHaveLength(2);
      expect(JSON.stringify(assistants)).toContain("recovered once");
    }),
  ));
