import { Clock, Duration, Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { AIError, QuotaExceededError } from "@opencode/ai/schema/errors";
import { expect, test } from "vitest";
import { bindTestHandle, currentMemory, resetFixture } from "../../test/reset.test-helper.ts";
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
          yield* llm.serve(() =>
            !failing
              ? TestLLM.text("quiet", "answer")
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
          yield* currentMemory(host, f.handle);
          const oldRequests = () =>
            llm
              .requests()
              .pipe(
                Effect.map(
                  (requests) =>
                    requests.filter((request) => JSON.stringify(request).includes("fail this turn"))
                      .length,
                ),
              );
          const requests = yield* oldRequests();
          yield* Effect.sleep("600 millis");
          expect(yield* oldRequests()).toBe(requests);
          if (kind === "other-provider") expect(alerts).toContain("provider-failing");
          else expect(alerts).not.toContain("provider-failing");
          expect(alerts).toContain(`clear:conversation-turn-failing:${old.id}`);
          if (kind === "quota") expect(alerts).toContain("clear:go-cap");
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
);
