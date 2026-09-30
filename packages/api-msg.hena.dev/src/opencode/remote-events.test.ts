import { Effect, Scope, Stream } from "effect";
import { expect, test } from "vitest";
import { withRemoteHost, awaitRemote } from "../../test/remote-host.test-helper.ts";
import { providerUnavailable } from "../../test/messaging-host.test-helper.ts";

test("remote outcomes deliver native success/failure events but exclude session and message updates", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const observed: Array<string> = [];
      yield* Effect.forkIn(
        remote.outcomes.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              observed.push(event.type);
            }),
          ),
        ),
        yield* Scope.Scope,
      );
      yield* awaitRemote(() => observed.length > 0);
      const session = yield* remote.createSession("persona1");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "succeed" });
      yield* remote.sessions.wait(session.id);
      yield* llm.serve(() => providerUnavailable("offline"));
      yield* remote.sessions.prompt({ sessionID: session.id, text: "fail" });
      yield* remote.sessions.wait(session.id);
      yield* awaitRemote(() => observed.includes("session.execution.failed"));
      expect(observed).toEqual([
        "server.connected",
        "session.execution.succeeded",
        "session.execution.failed",
      ]);
    }),
  ));

test("remote interrupt reports whether a native execution was actually running", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      expect(yield* remote.sessions.interrupt(session.id)).toBe(false);
      const gate = yield* llm.gate();
      yield* remote.sessions.prompt({ sessionID: session.id, text: "blocked turn" });
      yield* gate.started;
      expect(yield* remote.sessions.interrupt(session.id)).toBe(true);
      yield* gate.release;
      yield* remote.sessions.wait(session.id);
      expect(yield* remote.sessions.interrupt(session.id)).toBe(false);
    }),
  ));

test("native permission requests enforce the persona session's scoped allowlist", () =>
  withRemoteHost((remote) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      // Agent/plugin policy may deny independently; verify that the Session's
      // own catch-all deny is durably present in the public native API too.
      const persisted = yield* remote.sessions.get(session.id);
      expect(persisted.permissions?.filter((rule) => rule.effect === "deny")).toEqual([
        { action: "*", resource: "*", effect: "deny" },
      ]);
      for (const action of ["send", "read", "react", "wait"]) {
        const result = yield* remote.client.permission
          .create({
            sessionID: session.id,
            action,
            resources: ["conversation:+821012345678", "other-resource"],
          })
          .pipe(Effect.timeout("1 second"));
        expect(result.effect).toBe("allow");
      }
      const forbidden = yield* remote.client.permission
        .create({
          sessionID: session.id,
          action: "filesystem.write",
          resources: ["/sensitive/operator-project"],
        })
        .pipe(Effect.timeout("1 second"));
      expect(forbidden.effect).toBe("deny");
      expect(yield* remote.client.permission.list({ sessionID: session.id })).toEqual([]);
    }),
  ));
