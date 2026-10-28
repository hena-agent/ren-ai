import { rm } from "node:fs/promises";
import { TestLLM } from "@opencode/ai/testing";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { expect, test, vi } from "vitest";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { scriptedPersona } from "../../test/messaging-host.test-helper.ts";
import { startScriptedMessagingHost } from "../../test/host.test-helper.ts";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";

test.each(["generation", "context", "attachment", "acknowledgement"] as const)(
  "a burst arriving during %s replaces the stale draft with one reply to every message",
  async (stage) => {
    const { root, personaDirectory } = await messagingFixture("burst-replies-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const generating = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const held = Deferred.succeed(generating, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
          );
          const admitting = yield* Deferred.make<void>();
          const admitted = yield* Deferred.make<void>();
          const holdAdmission = Deferred.succeed(admitting, undefined).pipe(
            Effect.andThen(Deferred.await(admitted)),
          );
          const fake = fakeMessages();
          const llm = yield* scriptedPersona();
          let step = 0;
          let replied = false;
          let partial = false;
          const combined: { context: string; system: string }[] = [];
          yield* llm.serve((request) => {
            if (!request.tools.some((tool) => tool.name === "send"))
              return TestLLM.text("title", "title");
            if (step++ === 0)
              return Stream.unwrap(
                (stage !== "context" ? held : Effect.void).pipe(
                  Effect.as(Stream.fromIterable(TestLLM.tool("stale", "send", { text: "Just A" }))),
                ),
              );
            const context = JSON.stringify(request.messages);
            if (
              stage === "acknowledgement" &&
              !partial &&
              context.includes("Message B") &&
              !context.includes("Message C")
            ) {
              partial = true;
              return TestLLM.tool("partial", "send", {
                text: "Reply to A and B only",
              });
            }
            if (!replied && context.includes("Message C")) {
              replied = true;
              combined.push({ context, system: JSON.stringify(request.system) });
              return TestLLM.tool("combined", "send", {
                text: "Reply to A, B and C",
              });
            }
            return TestLLM.text("done", "answer");
          });
          const host = yield* startScriptedMessagingHost(
            root,
            personaDirectory,
            llm,
            {
              ...fake.messages,
              // Like the Worker: one alarm-driven intake call, no live Mac subscription.
              follow: () => Effect.succeed(() => {}),
              lastOutgoingStatus: (handle) =>
                (stage === "context" ? held : Effect.void).pipe(
                  Effect.andThen(fake.messages.lastOutgoingStatus(handle)),
                ),
              image: () =>
                holdAdmission.pipe(
                  Effect.as({
                    uri: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
                  }),
                ),
            },
            fakeGestures().gestures,
            true,
            false,
          );
          const prompt = host.sessions.prompt;
          const admission = vi
            .spyOn(host.sessions, "prompt")
            .mockImplementation((input) =>
              prompt(input).pipe(
                Effect.tap(() =>
                  stage === "acknowledgement" && input.text?.includes("Message B")
                    ? holdAdmission
                    : Effect.void,
                ),
              ),
            );
          yield* Effect.addFinalizer(() => Effect.sync(() => admission.mockRestore()));
          const session = yield* host.createSession("persona1");
          const handle = "burst@example.com";
          yield* host.conversations.create(registration(handle, session.id));
          yield* fake.text(handle, "Message A", Date.now());
          yield* host.heartbeat.intake;
          yield* Deferred.await(generating).pipe(Effect.timeout("5 seconds"));
          const second = yield* Effect.forkScoped(
            fake
              .text(
                handle,
                "Message B",
                Date.now(),
                stage === "attachment"
                  ? {
                      attachments: [
                        { path: "/photo.png", mimeType: "image/png", uti: null, missing: false },
                      ],
                    }
                  : {},
              )
              .pipe(Effect.andThen(host.heartbeat.intake)),
          );
          let bubblesBeforeRelease = fake.bubbles.length;
          if (stage === "attachment" || stage === "acknowledgement") {
            yield* Deferred.await(admitting).pipe(Effect.timeout("5 seconds"));
            yield* Deferred.succeed(finish, undefined);
            if (stage === "acknowledgement") {
              yield* fake.text(handle, "Message C", Date.now());
              yield* Effect.sleep("4500 millis");
            } else yield* host.sessions.wait(session.id).pipe(Effect.timeout("5 seconds"));
            bubblesBeforeRelease = fake.bubbles.length;
            yield* Deferred.succeed(admitted, undefined);
          }
          yield* Fiber.join(second);
          if (stage !== "acknowledgement") yield* fake.text(handle, "Message C", Date.now());
          yield* host.heartbeat.intake;
          yield* Deferred.succeed(finish, undefined);
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("10 seconds"));
          expect(bubblesBeforeRelease).toBe(0);
          expect(combined).toHaveLength(1);
          const context = combined[0]!.context;
          expect(context).toContain("Discard this unsent draft");
          expect(context).toContain("the User never received it");
          expect(context).toContain("Do not resume, paraphrase, or explain it later");
          expect(combined[0]!.system).toContain(
            "취소된 초안과 그 답변에 이어 보내려던 내용은 미뤄 두지 말고 폐기해",
          );
          for (const text of ["Message A", "Message B", "Message C"])
            expect(context).toContain(text);
          expect(fake.bubbles).toEqual([{ handle, text: "Reply to A, B and C" }]);
          const sql = yield* SqlClient.SqlClient;
          expect(yield* sql`SELECT tool_call_id AS callID FROM send ORDER BY id`).toEqual([
            { callID: "combined" },
          ]);
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
