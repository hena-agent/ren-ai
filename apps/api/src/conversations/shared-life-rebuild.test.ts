import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { fakeMessages } from "@ren-ai/imsg/testing";
import { personaMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import {
  messagingFixture,
  registration,
  runMessagingTest,
} from "../../test/messaging.test-helper.ts";
import {
  quietTestHost,
  scriptedPersona,
  startConversationHost,
} from "../../test/messaging-host.test-helper.ts";
import { rebuilder } from "./rebuild-session.ts";
import { restoreMemory } from "../../test/memory.test-helper.ts";

test("interrupted rebuild recovery keeps both scopes and the durable write fence until replay finishes", async () => {
  const fixture = await messagingFixture("shared-rebuild-");
  const fake = fakeMessages();
  let fail = false;
  const messages = {
    ...fake.messages,
    after: (cursor: number) =>
      fail ? Effect.fail(new Error("Replay unavailable")) : fake.messages.after(cursor),
  };
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* quietTestHost(fixture.root, fixture.personaDirectory, messages);
        const original = yield* host.createSession("persona1", undefined, "stable-conversation");
        const conversation = yield* host.conversations.create({
          ...registration("rebuild@example.com", original.id),
          conversationKey: "stable-conversation",
        });
        const root = original.location.directory;
        const relation = join(root, "conversations", "stable-conversation");
        yield* Effect.promise(() =>
          restoreMemory(root, {
            additional: {},
            shortTerm: "Her life continues",
            longTerm: [],
            receipts: {},
          }),
        );
        yield* Effect.promise(() =>
          restoreMemory(relation, {
            state: { affection: 83 },
            additional: {},
            shortTerm: "Private relationship",
            longTerm: [],
            receipts: {},
          }),
        );
        fail = true;
        expect(
          (yield* host.operator.rebuild(conversation.handle).pipe(Effect.flip)).message,
        ).toContain("Replay unavailable");
        const replacement = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(replacement.sessionID).not.toBe(original.id);
        expect(
          yield* Effect.promise(() => readSessionBinding(root, replacement.sessionID)),
        ).toMatchObject({ conversationKey: "stable-conversation", writable: false });
        const recovered = yield* rebuilder(host.conversations, host, host.intake.replay);
        fail = false;
        yield* recovered.pending;
        expect(
          yield* Effect.promise(() => readSessionBinding(root, replacement.sessionID)),
        ).toMatchObject({ conversationKey: "stable-conversation", writable: true });
        expect((yield* Effect.promise(() => readRuntime(root)))?.shortTerm).toBe(
          "Her life continues",
        );
        expect(yield* Effect.promise(() => readRuntime(relation))).toMatchObject({
          state: { affection: 83 },
          shortTerm: "Private relationship",
        });
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a superseded rebuild cannot reopen its old session when its replay finishes", async () => {
  const fixture = await messagingFixture("superseded-rebuild-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const firstFinish = yield* Deferred.make<void>();
        const secondFinish = yield* Deferred.make<void>();
        const llm = yield* scriptedPersona();
        let turn = 0;
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "update_state"))
            return TestLLM.text("title", "title");
          const first = turn++ === 0;
          return Stream.unwrap(
            Deferred.succeed(first ? firstStarted : secondStarted, undefined).pipe(
              Effect.andThen(Deferred.await(first ? firstFinish : secondFinish)),
              Effect.as(Stream.fromIterable(TestLLM.text("replayed", "done"))),
            ),
          );
        });
        const { host, original, conversation } = yield* startConversationHost(
          fixture,
          llm,
          fakeMessages().messages,
          "superseded@example.com",
        );
        const first = yield* host.operator.rebuild(conversation.handle).pipe(Effect.forkScoped);
        yield* Deferred.await(firstStarted).pipe(Effect.timeout("5 seconds"));
        const previous = (yield* host.conversations.byHandle(conversation.handle))!;
        const second = yield* host.operator.rebuild(conversation.handle).pipe(Effect.forkScoped);
        yield* Deferred.await(secondStarted).pipe(Effect.timeout("5 seconds"));
        const current = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(current.sessionID).not.toBe(previous.sessionID);
        yield* Deferred.succeed(firstFinish, undefined);
        yield* Fiber.join(first);
        expect(
          (yield* Effect.promise(() =>
            readSessionBinding(original.location.directory, previous.sessionID),
          )).writable,
        ).toBe(false);
        yield* Effect.promise(async () => {
          await expect(
            personaMemory(original.location.directory, previous.sessionID).run(
              "update_state",
              { scores: { affection: 99 }, additions: {}, remove: [], reason: "Stale replay" },
              "stale",
              "history",
            ),
          ).rejects.toThrow("read-only");
        });
        expect(yield* host.conversations.rebuilding(current)).toBe(true);
        yield* Deferred.succeed(secondFinish, undefined);
        yield* Fiber.join(second);
        expect(
          (yield* Effect.promise(() =>
            readSessionBinding(original.location.directory, current.sessionID),
          )).writable,
        ).toBe(true);
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("replay admission cannot reopen State writes while the scripted native model is still running", async () => {
  const fixture = await messagingFixture("replay-write-fence-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const attempt = yield* Deferred.make<void>();
        const rejected = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const llm = yield* scriptedPersona();
        let step = 0;
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "update_state"))
            return TestLLM.text("title", "title");
          if (step++ === 0)
            return Stream.unwrap(
              Deferred.succeed(admitted, undefined).pipe(
                Effect.andThen(Deferred.await(attempt)),
                Effect.as(
                  Stream.fromIterable(
                    TestLLM.tool("historical-state", "update_state", {
                      scope: "life",
                      scores: { mood: 99 },
                      additions: {},
                      remove: [],
                      reason: "Replaying a historical event",
                    }),
                  ),
                ),
              ),
            );
          expect(JSON.stringify(request.messages)).toContain("update_state failed");
          return Stream.unwrap(
            Deferred.succeed(rejected, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as(Stream.fromIterable(TestLLM.text("done", "done"))),
            ),
          );
        });
        const { host, original, conversation } = yield* startConversationHost(
          fixture,
          llm,
          fakeMessages().messages,
          "gated-rebuild@example.com",
        );
        const root = original.location.directory;
        yield* Effect.promise(() =>
          restoreMemory(root, {
            state: { mood: 50, energy: 50, stress: 50, connection: 50, solitude: 50 },
            additional: {},
            shortTerm: "Present life",
            longTerm: [],
            receipts: {},
          }),
        );
        const rebuild = yield* host.operator.rebuild(conversation.handle).pipe(Effect.forkScoped);
        yield* Deferred.await(admitted).pipe(Effect.timeout("5 seconds"));
        const current = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(yield* host.conversations.rebuilding(current)).toBe(true);
        expect(
          (yield* Effect.promise(() => readSessionBinding(root, current.sessionID))).writable,
        ).toBe(false);
        yield* Deferred.succeed(attempt, undefined);
        yield* Deferred.await(rejected).pipe(Effect.timeout("5 seconds"));
        expect((yield* Effect.promise(() => readRuntime(root)))?.state?.mood).toBe(50);
        expect(
          (yield* Effect.promise(() => readSessionBinding(root, current.sessionID))).writable,
        ).toBe(false);
        yield* Deferred.succeed(finish, undefined);
        expect(yield* Fiber.join(rebuild)).toBe("rebuilt");
        expect(
          (yield* Effect.promise(() => readSessionBinding(root, current.sessionID))).writable,
        ).toBe(true);
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
