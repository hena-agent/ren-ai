import { Clock, Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { AIError, QuotaExceededError } from "@opencode/ai/schema/errors";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import { bindTestHandle, resetFixture, startTestHandle } from "../../test/reset.test-helper.ts";
import {
  providerUnavailable,
  scriptedPersona,
  startTestHost,
} from "../../test/messaging-host.test-helper.ts";

test.each(["provider", "quota", "other-provider", "other-quota"])(
  "reset forgets the retired session's %s failure timers",
  async (kind) => {
    const f = await resetFixture("reset-alerts-");
    const clock = Effect.runSync(Clock.Clock);
    let elapsed = 0;
    const alerts: string[] = [];
    try {
      await f.run(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          let failing = true;
          yield* llm.serve((request) =>
            !failing &&
            !(kind.startsWith("other-") && JSON.stringify(request).includes("other failure"))
              ? JSON.stringify(request).includes("<conversation-started")
                ? TestLLM.tool("fresh-wait", "wait", { seconds: 3300 })
                : TestLLM.text("quiet", "answer")
              : kind.includes("provider")
                ? providerUnavailable("unavailable")
                : TestLLM.failAfter(
                    new AIError({ reason: new QuotaExceededError({ message: "quota" }) }),
                  ),
          );
          const host = yield* startTestHost(
            f.root,
            f.personaDirectory,
            llm,
            f.fake.messages,
            ":memory:",
            {
              raise: (name) =>
                Effect.sync(() => {
                  alerts.push(name);
                }),
              clear: (name) =>
                Effect.sync(() => {
                  alerts.push(`clear:${name}`);
                }),
            },
          );
          const old = yield* bindTestHandle(host, f.handle);
          yield* host.sessions.prompt({ sessionID: old.id, text: "fail this turn" });
          yield* host.sessions.wait(old.id);
          yield* host.heartbeat.failedTurns;
          if (kind.startsWith("other-")) {
            const other = yield* bindTestHandle(host, "other@example.com", "persona2");
            yield* host.sessions.prompt({ sessionID: other.id, text: "other failure" });
            yield* host.sessions.wait(other.id);
            yield* host.heartbeat.failedTurns;
          }
          yield* Effect.sleep("20 millis");
          failing = false;
          yield* f.fake.text(f.handle, "/reset", Date.now());
          yield* startTestHandle(host, f.fake.messages, f.handle);
          const fresh = Session.ID.make((yield* host.conversations.byHandle(f.handle))!.sessionID);
          yield* Effect.promise(async () => {
            await expect
              .poll(
                async () =>
                  JSON.stringify(
                    await Effect.runPromise(host.sessions.messages({ sessionID: fresh })),
                  ),
                { timeout: 5000 },
              )
              .toContain('"status":"running"');
          });
          if (kind === "quota") {
            failing = true;
            const subsequent = yield* bindTestHandle(host, "subsequent@example.com", "persona2");
            yield* host.sessions.prompt({
              sessionID: subsequent.id,
              text: "subsequent quota failure",
            });
            yield* host.sessions.wait(subsequent.id);
            yield* host.heartbeat.failedTurns;
          }
          const requestsFor = (text: string) =>
            llm
              .requests()
              .pipe(
                Effect.map(
                  (requests) =>
                    requests.filter((request) => JSON.stringify(request).includes(text)).length,
                ),
              );
          const requests = yield* requestsFor("fail this turn");
          const otherRequests = yield* requestsFor("other failure");
          elapsed += kind.includes("quota") ? 900_000 : 600_000;
          yield* host.heartbeat.failedTurns;
          yield* Effect.sleep("600 millis");
          expect(yield* requestsFor("fail this turn")).toBe(requests);
          if (kind === "other-provider") expect(alerts).toContain("provider-failing");
          else expect(alerts).not.toContain("provider-failing");
          expect(alerts).toContain(`clear:conversation-turn-failing:${old.id}`);
          if (kind === "quota") expect(alerts).toContain("clear:go-cap");
          if (kind === "quota") expect(yield* requestsFor("subsequent quota failure")).toBe(2);
          if (kind.includes("provider")) expect(alerts).not.toContain("clear:go-cap");
          if (kind === "other-quota")
            yield* Effect.promise(async () => {
              await expect
                .poll(() => Effect.runPromise(requestsFor("other failure")), { timeout: 5000 })
                .toBeGreaterThan(otherRequests);
            });
          yield* host.sessions.interrupt(fresh);
          yield* host.sessions.wait(fresh);
        }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: Effect.map(clock.currentTimeMillis, (now) => now + elapsed),
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + elapsed,
            currentTimeNanos: clock.currentTimeNanos,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) => clock.sleep(duration),
          }),
        ),
      );
    } finally {
      await f.cleanup();
    }
  },
  20_000,
);
