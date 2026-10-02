import { Clock, Duration, Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { AIError, QuotaExceededError } from "@opencode/ai/schema/errors";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import { bindTestHandle, resetFixture, onboardTestHandle } from "../../test/reset.test-helper.ts";
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
    const alerts: string[] = [];
    try {
      await f.run(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          let failing = true;
          yield* llm.serve((request) =>
            !failing
              ? JSON.stringify(request).includes("<conversation-started")
                ? TestLLM.tool("fresh-wait", "wait", { minutes: 720 })
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
          yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
          const old = yield* bindTestHandle(host, f.handle);
          yield* host.sessions.prompt({ sessionID: old.id, text: "fail this turn" });
          yield* host.sessions.wait(old.id);
          if (kind.startsWith("other-")) {
            const other = yield* bindTestHandle(host, "other@example.com");
            yield* host.sessions.prompt({ sessionID: other.id, text: "other failure" });
            yield* host.sessions.wait(other.id);
          }
          yield* Effect.sleep("20 millis");
          failing = false;
          yield* f.fake.text(f.handle, "/reset", Date.now());
          yield* onboardTestHandle(host, f.handle);
          const fresh = Session.ID.make((yield* host.conversations.byHandle(f.handle))!.sessionID);
          while (
            !JSON.stringify(yield* host.sessions.messages({ sessionID: fresh })).includes(
              '"status":"running"',
            )
          )
            yield* Effect.sleep("10 millis");
          if (kind === "quota") {
            failing = true;
            const subsequent = yield* bindTestHandle(host, "subsequent@example.com");
            yield* host.sessions.prompt({
              sessionID: subsequent.id,
              text: "subsequent quota failure",
            });
            yield* host.sessions.wait(subsequent.id);
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
          yield* Effect.sleep("600 millis");
          expect(yield* requestsFor("fail this turn")).toBe(requests);
          if (kind === "other-provider") expect(alerts).toContain("provider-failing");
          else expect(alerts).not.toContain("provider-failing");
          expect(alerts).toContain(`clear:conversation-turn-failing:${old.id}`);
          if (kind === "quota") expect(alerts).toContain("clear:go-cap");
          if (kind === "quota") expect(yield* requestsFor("subsequent quota failure")).toBe(2);
          if (kind.includes("provider")) expect(alerts).not.toContain("clear:go-cap");
          if (kind === "other-quota")
            expect(yield* requestsFor("other failure")).toBeGreaterThan(otherRequests);
          yield* host.sessions.interrupt(fresh);
          yield* host.sessions.wait(fresh);
        }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            sleep: (duration) =>
              clock.sleep(
                [600_000, 900_000].includes(Duration.toMillis(duration))
                  ? Duration.millis(500)
                  : duration,
              ),
          }),
        ),
      );
    } finally {
      await f.cleanup();
    }
  },
  20_000,
);
