import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { AIError, AuthenticationError, QuotaExceededError } from "@opencode/ai/schema/errors";
import { LanguageModel } from "@opencode/ai";
import { OpenAIChat } from "@opencode/ai/protocols";
import { TestLLM } from "@opencode/ai/testing";
import { SessionRunnerModel } from "@opencode/core/session/runner/model";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { startMessagingHost } from "../main.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";
import { failedTurns } from "./failed-turns.ts";
import { scriptedOverrides } from "./scripted-overrides.test-helper.ts";

const advanceUntil = <E, R>(done: () => Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let tick = 0; tick < 30; tick++) {
      if (yield* done()) return;
      yield* TestClock.adjust("20 millis");
    }
  });

test("quota holds Conversations and probes one every 15 minutes before releasing the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "failed-turns-"));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "persona1.md"),
    "---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: Hi\nmemory: Remember.\n---\nYou are Persona1.\n",
  );
  const model = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "probe", provider: "test", route: OpenAIChat.route }),
    {
      capabilities: { input: ["text"], output: ["text"], tools: true },
      cost: [],
      limit: { context: 100_000, output: 1_000 },
    },
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
          let mode: "quota" | "auth" | "ok" = "quota";
          let secondStillCapped = false;
          let cappedRequest = "never-capped";
          const alerts: string[] = [];
          const details: string[] = [];
          yield* llm.serve((request) =>
            mode === "quota" ||
            (secondStillCapped && JSON.stringify(request).includes("second@example.com")) ||
            (mode === "auth" && JSON.stringify(request).includes(cappedRequest))
              ? TestLLM.failAfter(
                  new AIError({ reason: new QuotaExceededError({ message: "Go cap reached" }) }),
                )
              : mode === "auth"
                ? TestLLM.failAfter(
                    new AIError({
                      reason: new AuthenticationError({ message: "Bad credentials" }),
                    }),
                  )
                : TestLLM.text("hello", "reply"),
          );
          const notifications = {
            raise: (name: string, detail?: string) =>
              Effect.sync(() => {
                alerts.push(`raise:${name}`);
                details.push(detail ?? "");
              }),
            clear: (name: string) =>
              Effect.sync(() => {
                alerts.push(`clear:${name}`);
              }),
          };
          const overrides = scriptedOverrides(llm, model);
          const host = yield* startMessagingHost(
            join(root, "isolated"),
            {
              configDirectory: join(root, "config"),
              databasePath: ":memory:",
              personaDirectory,
              providers: {},
              model: "test/probe",
              overrides,
            },
            fakeMessages().messages,
            fakeGestures().gestures,
            { turnstileSecret: "test", notice: noticeCopy },
            notifications,
          );
          const bind = (sessionID: string, handle: string) =>
            host.conversations.create({
              handle,
              locale: "ko",
              consentVersion: "v1",
              consentLanguage: "ko",
              personaID: "persona1",
              sessionID,
            });
          // A provider failure that clears before any cap must not stop the event listener.
          mode = "auth";
          const early = yield* host.createSession("persona1");
          yield* bind(early.id, "early@example.com");
          yield* host.sessions.prompt({ sessionID: early.id, text: "early" });
          yield* host.sessions.wait(early.id);
          yield* TestClock.adjust("20 millis");
          mode = "ok";
          yield* host.sessions.resume(early.id);
          yield* host.sessions.wait(early.id);
          yield* TestClock.adjust("20 millis");
          mode = "quota";
          const baseline = (yield* llm.requests()).length;
          const sessions = [];
          for (const handle of ["first@example.com", "second@example.com"]) {
            const session = yield* host.createSession("persona1");
            sessions.push(session);
            yield* bind(session.id, handle);
            yield* host.sessions.prompt({ sessionID: session.id, text: handle });
            yield* host.sessions.wait(session.id);
            expect((yield* host.sessions.get(session.id)).outcome).toBe("failed");
            if (sessions.length === 1) {
              yield* TestClock.adjust("20 millis");
              expect(alerts).toContain("raise:go-cap");
              expect(alerts).not.toContain(`raise:conversation-turn-failing:${session.id}`);
            }
          }
          yield* TestClock.adjust("20 millis");
          expect(alerts.filter((alert) => alert === "raise:go-cap")).toHaveLength(1);
          expect(details).toContain("OpenCode Go cap reached");
          expect(yield* llm.requests()).toHaveLength(baseline + 2);
          yield* TestClock.adjust("14 minutes");
          expect(yield* llm.requests()).toHaveLength(baseline + 2);
          yield* TestClock.adjust("1 minute");
          yield* TestClock.adjust("20 millis");
          expect(yield* llm.requests()).toHaveLength(baseline + 3);
          expect(JSON.stringify((yield* llm.requests())[baseline + 2])).toContain(
            "first@example.com",
          );
          mode = "ok";
          secondStillCapped = true;
          yield* TestClock.adjust("15 minutes");
          yield* TestClock.adjust("50 millis");
          expect((yield* host.sessions.get(sessions[0]!.id)).outcome).toBe("failed");
          expect((yield* host.sessions.get(sessions[1]!.id)).outcome).toBe("failed");
          yield* TestClock.adjust("15 minutes");
          yield* TestClock.adjust("150 millis");
          yield* host.sessions.wait(sessions[1]!.id);
          yield* Effect.yieldNow;
          yield* advanceUntil(() =>
            Effect.succeed(alerts.filter((item) => item === "raise:go-cap").length === 2),
          );
          expect((yield* host.sessions.get(sessions[0]!.id)).outcome).toBe("succeeded");
          expect((yield* host.sessions.get(sessions[1]!.id)).outcome).toBe("failed");
          expect(alerts.filter((alert) => alert === "raise:go-cap")).toHaveLength(2);
          secondStillCapped = false;
          const stillHeld = (yield* llm.requests()).length;
          yield* TestClock.adjust("899 seconds");
          expect(yield* llm.requests()).toHaveLength(stillHeld);
          yield* TestClock.adjust("1 second");
          yield* TestClock.adjust("50 millis");
          yield* host.sessions.wait(sessions[0]!.id);
          yield* host.sessions.wait(sessions[1]!.id);
          const quotaRequests = yield* llm.requests();
          expect(JSON.stringify(quotaRequests[baseline + 3])).toContain("second@example.com");
          expect(JSON.stringify(quotaRequests[baseline + 4])).toContain("first@example.com");
          expect((yield* host.sessions.get(sessions[0]!.id)).outcome).toBe("succeeded");
          expect((yield* host.sessions.get(sessions[1]!.id)).outcome).toBe("succeeded");
          expect(alerts).toContain("clear:go-cap");

          // An old probe must not run early in a later cap episode.
          yield* TestClock.adjust("7 minutes");
          mode = "quota";
          const later = yield* host.createSession("persona1");
          yield* bind(later.id, "later@example.com");
          yield* host.sessions.prompt({ sessionID: later.id, text: "later" });
          yield* host.sessions.wait(later.id);
          yield* TestClock.adjust("20 millis");
          const laterRequests = (yield* llm.requests()).length;
          yield* TestClock.adjust("8 minutes");
          expect(yield* llm.requests()).toHaveLength(laterRequests);
          mode = "ok";
          yield* TestClock.adjust("7 minutes");
          yield* TestClock.adjust("20 millis");
          yield* host.sessions.wait(later.id);
          expect((yield* host.sessions.get(later.id)).outcome).toBe("succeeded");

          // A non-retryable provider error uses our own per-Conversation schedule.
          mode = "auth";
          const broken = yield* host.createSession("persona1");
          yield* bind(broken.id, "broken@example.com");
          yield* host.sessions.prompt({ sessionID: broken.id, text: "hi" });
          yield* host.sessions.wait(broken.id);
          yield* TestClock.adjust("20 millis");
          const before = (yield* llm.requests()).length;
          yield* host.sessions.resume(broken.id).pipe(Effect.catchCause(() => Effect.void));
          yield* host.sessions.wait(broken.id);
          yield* TestClock.adjust("20 millis");
          expect(yield* llm.requests()).toHaveLength(before + 1);
          yield* TestClock.adjust("999 millis");
          expect(yield* llm.requests()).toHaveLength(before + 1);
          yield* TestClock.adjust("1 millis");
          expect(yield* llm.requests()).toHaveLength(before + 1);
          expect(alerts).not.toContain(`raise:conversation-turn-failing:${broken.id}`);
          yield* TestClock.adjust("1 second");
          yield* TestClock.adjust("20 millis");
          expect(yield* llm.requests()).toHaveLength(before + 2);
          expect(alerts).toContain(`raise:conversation-turn-failing:${broken.id}`);
          expect(details).toContain("A Conversation's turn keeps failing");
          mode = "ok";
          yield* host.sessions.prompt({ sessionID: sessions[0]!.id, text: "unrelated" });
          yield* host.sessions.wait(sessions[0]!.id);
          mode = "auth";
          yield* TestClock.adjust("10 minutes");
          expect(alerts).toContain("raise:provider-failing");
          expect(details).toContain("Provider failing for 10 minutes");
          mode = "ok";
          yield* TestClock.adjust("15 minutes");
          yield* TestClock.adjust("20 millis");
          expect((yield* host.sessions.get(broken.id)).outcome).toBe("succeeded");
          expect(alerts).toContain("clear:provider-failing");

          // A cap holds failures that originally came from another provider problem too.
          mode = "auth";
          cappedRequest = "cap@example.com";
          const heldByCap = yield* host.createSession("persona1");
          const capped = yield* host.createSession("persona1");
          for (const [session, handle] of [
            [heldByCap, "held@example.com"],
            [capped, cappedRequest],
          ] as const) {
            yield* bind(session.id, handle);
            yield* host.sessions.prompt({ sessionID: session.id, text: handle });
            yield* host.sessions.wait(session.id);
            yield* TestClock.adjust("20 millis");
          }
          const duringCap = yield* host.createSession("persona1");
          yield* bind(duringCap.id, "during@example.com");
          yield* host.sessions.prompt({ sessionID: duringCap.id, text: "during@example.com" });
          yield* host.sessions.wait(duringCap.id);
          yield* TestClock.adjust("20 millis");
          const heldRequests = (yield* llm.requests()).length;
          yield* TestClock.adjust("1 second");
          expect(yield* llm.requests()).toHaveLength(heldRequests);
          const providerAlerts = alerts.filter((item) => item === "raise:provider-failing").length;
          yield* TestClock.adjust("599 seconds");
          expect(yield* llm.requests()).toHaveLength(heldRequests);
          expect(alerts.filter((item) => item === "raise:provider-failing")).toHaveLength(
            providerAlerts,
          );
          mode = "ok";
          yield* TestClock.adjust("5 minutes");
          yield* TestClock.adjust("20 millis");
          yield* host.sessions.wait(heldByCap.id);
          yield* host.sessions.wait(capped.id);
          yield* advanceUntil(() =>
            Effect.forEach([heldByCap, capped, duringCap], (session) =>
              host.sessions.get(session.id).pipe(Effect.map((info) => info.outcome)),
            ).pipe(Effect.map((outcomes) => outcomes.every((outcome) => outcome === "succeeded"))),
          );
          expect((yield* host.sessions.get(heldByCap.id)).outcome).toBe("succeeded");
          expect((yield* host.sessions.get(capped.id)).outcome).toBe("succeeded");
          expect((yield* host.sessions.get(duringCap.id)).outcome).toBe("succeeded");

          // This failure predates the Conversation binding, so only startup scanning can find it.
          mode = "auth";
          const orphan = yield* host.createSession("persona1");
          yield* host.sessions.prompt({ sessionID: orphan.id, text: "before restart" });
          yield* host.sessions.wait(orphan.id);
          yield* TestClock.adjust("10 minutes");
          expect(alerts.filter((item) => item === "raise:provider-failing")).toHaveLength(1);
          yield* bind(orphan.id, "restored@example.com");
          mode = "ok";
          const beforeRecovery = (yield* llm.requests()).length;
          yield* failedTurns(host, host.conversations, notifications);
          yield* host.sessions.wait(orphan.id);
          expect((yield* host.sessions.get(orphan.id)).outcome).toBe("succeeded");
          expect(yield* llm.requests()).toHaveLength(beforeRecovery + 1);

          // A cleared failure must not emit a late provider alert or retry an already good turn.
          mode = "auth";
          yield* host.sessions.prompt({ sessionID: orphan.id, text: "another turn" });
          yield* host.sessions.wait(orphan.id);
          yield* TestClock.adjust("20 millis");
          mode = "ok";
          yield* host.sessions.resume(orphan.id);
          yield* TestClock.adjust("10 minutes");
          expect(alerts.filter((item) => item === "raise:provider-failing")).toHaveLength(1);

          // Blocking a Conversation while its retry is waiting stops the resume.
          mode = "auth";
          yield* host.sessions.prompt({ sessionID: orphan.id, text: "blocked" });
          yield* host.sessions.wait(orphan.id);
          yield* TestClock.adjust("20 millis");
          yield* host.conversations.block("restored@example.com");
          const requests = (yield* llm.requests()).length;
          yield* TestClock.adjust("1 second");
          expect(yield* llm.requests()).toHaveLength(requests);

          const missing = yield* host.createSession("persona1");
          yield* bind(missing.id, "missing@example.com");
          yield* host.sessions.remove(missing.id);
          expect(Option.isNone(yield* host.sessions.get(missing.id).pipe(Effect.option))).toBe(
            true,
          );
          expect(yield* host.conversations.bySession(missing.id)).toBeDefined();
          const beforeMissing = (yield* llm.requests()).length;
          yield* failedTurns(host, host.conversations, notifications);
          expect(yield* llm.requests()).toHaveLength(beforeMissing);
        }).pipe(
          Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          Effect.provide(TestClock.layer()),
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
