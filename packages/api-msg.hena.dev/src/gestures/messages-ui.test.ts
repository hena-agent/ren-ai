import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { failure, setup } from "../../test/messages-ui.test-helper.ts";

type Fixture = Awaited<ReturnType<typeof setup>>;

const finishAfterDeadline = (task: Effect.Effect<void | boolean, Error>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(task);
        yield* TestClock.adjust("16 seconds");
        const result = fiber.pollUnsafe();
        yield* Fiber.interrupt(fiber);
        return result;
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

const expectTimeout = (
  completed: Awaited<ReturnType<typeof finishAfterDeadline>>,
  action: string,
) => {
  expect(completed).toBeDefined();
  expect(Exit.isFailure(completed!)).toBe(true);
  expect(Exit.match(completed!, { onFailure: Cause.pretty, onSuccess: () => "" })).toContain(
    `${action} timed out`,
  );
};

const expectReadAfterTimeout = async (fixture: Awaited<ReturnType<typeof setup>>) => {
  fixture.blockAction("", Effect.void);
  await Effect.runPromise(fixture.gestures.read("alice@example.com"));
  expect(fixture.events.at(-1)).toBe("park");
};

test("a stalled Apple Event cannot hold a read and the shared lock for five minutes", async () => {
  const fixture = await setup();
  fixture.blockAction("read", Effect.sleep("5 minutes"));
  const completed = await finishAfterDeadline(fixture.gestures.read("alice@example.com"));
  expectTimeout(completed, "read");
  expect(fixture.events.at(-1)).toBe("park");
  await expectReadAfterTimeout(fixture);
});

test("a stalled park finishes within the deadline and releases the shared lock", async () => {
  const fixture = await setup();
  fixture.blockAction("park", Effect.sleep("5 minutes"));
  const completed = await finishAfterDeadline(fixture.gestures.read("alice@example.com"));
  expectTimeout(completed, "park");
  expect(fixture.events.at(-1)).toBe("park");
  await expectReadAfterTimeout(fixture);
});

test("a stalled keystroke is followed by guarded cleanup, not another keystroke", async () => {
  const fixture = await setup();
  fixture.blockAction("key", Effect.sleep("5 minutes"));
  const completed = await finishAfterDeadline(
    fixture.gestures.typing("alice@example.com", "xy", 0),
  );
  expectTimeout(completed, "key");
  expect(fixture.events.slice(-2)).toEqual([
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
  expect(fixture.events.some((event) => event === "key y")).toBe(false);
});

test("typing checks the chat, guards each character, clears and parks", async () => {
  const { gestures, events } = await setup();
  expect(await Effect.runPromise(gestures.typing("alice@example.com", "hi", 0))).toBe(true);
  expect(events).toEqual([
    "ensure",
    "chats --limit 10000 --json",
    "open sms://open?groupid=alice%40example.com",
    "clear sms://open?groupid=alice%40example.com",
    "key h",
    "key i",
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
});

const expectTypingDuration = (typing: Effect.Effect<boolean, Error>, duration: number, spent = 0) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(100_000);
        const fiber = yield* Effect.forkScoped(typing);
        if (spent) yield* TestClock.adjust(spent);
        yield* TestClock.adjust(duration - spent - 1);
        const pending = fiber.pollUnsafe() === undefined;
        yield* TestClock.adjust(1);
        return { pending, result: yield* Fiber.join(fiber) };
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

test("typing spends its allotted time even without UI contention", async () => {
  const { gestures } = await setup();
  expect(await expectTypingDuration(gestures.typing("alice@example.com", "x", 60), 60)).toEqual({
    pending: true,
    result: true,
  });
});

test("time spent typing characters counts toward the typing duration", async () => {
  const fixture = await setup();
  fixture.pauseKey(Effect.sleep(40));
  expect(
    await expectTypingDuration(fixture.gestures.typing("alice@example.com", "x", 120), 120, 40),
  ).toEqual({ pending: true, result: true });
});

test.each([
  ["cannot start", (fixture: Fixture) => fixture.failOn("key")],
  ["exits non-zero", (fixture: Fixture) => fixture.exitOn("key", "key failed")],
])("typing stops on a guard that %s, and still clears and parks", async (_mode, fail) => {
  const fixture = await setup();
  fail(fixture);
  expect(await failure(fixture.gestures.typing("alice@example.com", "hi", 0))).toContain(
    "key failed",
  );
  expect(fixture.events).toEqual([
    "ensure",
    "chats --limit 10000 --json",
    "open sms://open?groupid=alice%40example.com",
    "clear sms://open?groupid=alice%40example.com",
    "key h",
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
});

test("a tapback that imsg rejects fails instead of counting as sent", async () => {
  const fixture = await setup();
  fixture.exitOn("react", "chat not found");
  expect(await failure(fixture.gestures.react("alice@example.com", "love"))).toBe(
    "Tapback failed: exit code 1: chat not found",
  );
});

test("a chat lookup that imsg rejects says why, not that the Conversation is missing", async () => {
  const fixture = await setup();
  fixture.exitOn("chats", "Invalid value for option: --limit");
  expect(await failure(fixture.gestures.read("alice@example.com"))).toBe(
    "Cannot find Conversation: Error: exit code 1: Invalid value for option: --limit",
  );
});

test("an interrupted typing Effect clears the draft and releases the lock", async () => {
  const fixture = await setup();
  const fiber = Effect.runFork(fixture.gestures.typing("alice@example.com", "x", 60_000));
  // Wait for the character (the typing Effect is then sleeping), not for completion.
  while (!fixture.events.includes("key x")) await new Promise((resolve) => setTimeout(resolve, 1));
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(fixture.events.slice(-2)).toEqual([
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
  await Effect.runPromise(fixture.gestures.read("alice@example.com"));
  expect(fixture.events.at(-1)).toBe("park");
});

test("one lock serializes every gesture across Conversations, and typing waits its turn", async () => {
  const fixture = await setup();
  fixture.setChats(
    '{"id":42,"identifier":"alice@example.com","service":"iMessage","is_group":false}\n' +
      '{"id":43,"identifier":"bob@example.com","service":"iMessage","is_group":false}\n',
  );
  const gate = await Effect.runPromise(Deferred.make<void>());
  fixture.blockReact(Deferred.await(gate));
  const reaction = Effect.runFork(fixture.gestures.react("alice@example.com", "love"));
  while (!fixture.events.some((event) => event.startsWith("react ")))
    await new Promise((resolve) => setTimeout(resolve, 1));
  const typing = Effect.runFork(fixture.gestures.typing("bob@example.com", "x", 0));
  const read = Effect.runFork(fixture.gestures.read("alice@example.com"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(typing.pollUnsafe()).toBeUndefined();
  expect(fixture.events.filter((event) => event === "ensure")).toHaveLength(1);
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  await Effect.runPromise(Fiber.join(reaction));
  expect(await Effect.runPromise(Fiber.join(typing))).toBe(true);
  await Effect.runPromise(Fiber.join(read));
  expect(fixture.events.filter((event) => event === "ensure" || event === "park")).toEqual(
    Array.from({ length: 3 }, () => ["ensure", "park"]).flat(),
  );
  expect(fixture.events).toContain("react --chat-id 42 --reaction love --json");
  expect(fixture.events).toContain("key x");
  expect(fixture.events).toContain("read sms://open?groupid=alice%40example.com");
});

test("reopens before a read and parks after tapbacks, including failures", async () => {
  const fixture = await setup();
  await Effect.runPromise(fixture.gestures.read("alice@example.com"));
  expect(fixture.events.slice(0, 4)).toEqual([
    "ensure",
    "chats --limit 10000 --json",
    "read sms://open?groupid=alice%40example.com",
    "park",
  ]);
  fixture.failOn("react");
  for (let n = 0; n < 3; n++) {
    await expect(
      Effect.runPromise(fixture.gestures.react("alice@example.com", "like")),
    ).rejects.toThrow("react failed");
  }
  expect(fixture.events.at(-1)).toBe("park");
  expect(fixture.alerts.filter((alert) => alert.startsWith("gestures:"))).toHaveLength(1);
  fixture.failOn("");
  await Effect.runPromise(fixture.gestures.react("alice@example.com", "question"));
  expect(fixture.alerts).toContain("clear: gestures");
  expect(fixture.alerts).toContain("clear: messages-window");
  expect(fixture.alerts.some((alert) => alert.includes("react: Tapback failed"))).toBe(true);
});

test("a window that cannot reopen alerts immediately and does not access the chat", async () => {
  const fixture = await setup();
  fixture.failOn("ensure");
  await expect(Effect.runPromise(fixture.gestures.read("alice@example.com"))).rejects.toThrow(
    "ensure failed",
  );
  expect(fixture.events).toEqual(["ensure", "park"]);
  expect(fixture.alerts.some((alert) => alert.startsWith("messages-window:"))).toBe(true);
  expect(fixture.alerts.some((alert) => alert.startsWith("gestures:"))).toBe(false);
  fixture.failOn("");
  await Effect.runPromise(fixture.gestures.read("alice@example.com"));
  expect(fixture.alerts).toContain("clear: messages-window");
});

test("parking and draft cleanup failures are not hidden", async () => {
  const fixture = await setup();
  fixture.failOn("park");
  await expect(Effect.runPromise(fixture.gestures.read("alice@example.com"))).rejects.toThrow(
    "park failed",
  );
  expect(fixture.alerts.filter((alert) => alert.startsWith("messages-window:"))).toHaveLength(0);
  fixture.failOn("clear");
  await expect(
    Effect.runPromise(fixture.gestures.typing("alice@example.com", "x", 0)),
  ).rejects.toThrow("clear failed");
  expect(fixture.events.slice(-2)).toEqual([
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
  expect(fixture.alerts.some((alert) => alert.startsWith("gestures:"))).toBe(true);
});

test("rejects missing, grouped, and malformed chat rows without reacting", async () => {
  const fixture = await setup();
  for (const row of [
    "null",
    "42",
    "{}",
    '{"service":"iMessage","is_group":false,"id":42}',
    '{"identifier":"bob@example.com","service":"iMessage","is_group":false,"id":42}',
    '{"identifier":"alice@example.com","is_group":false,"id":42}',
    '{"identifier":"alice@example.com","service":"SMS","is_group":false,"id":42}',
    '{"identifier":"alice@example.com","service":"iMessage","id":42}',
    '{"identifier":"alice@example.com","service":"iMessage","is_group":true,"id":42}',
    '{"identifier":"alice@example.com","service":"iMessage","is_group":false}',
    '{"identifier":"alice@example.com","service":"iMessage","is_group":false,"id":"42"}',
    '{"identifier":"alice@example.com","service":"iMessage","is_group":false,"id":0}',
  ]) {
    fixture.setChats(`${row}\n`);
    await expect(Effect.runPromise(fixture.gestures.read("alice@example.com"))).rejects.toThrow(
      "No direct",
    );
  }
  fixture.setChats("garbage\n");
  await expect(Effect.runPromise(fixture.gestures.read("alice@example.com"))).rejects.toThrow(
    "Cannot find",
  );
  expect(fixture.events.some((event) => event.startsWith("react "))).toBe(false);
});

test("skips blank chat-list lines and matches only the right direct handle", async () => {
  const fixture = await setup();
  fixture.setChats(
    '  \n{"identifier":"bob@example.com","service":"iMessage","is_group":false,"id":41}\n' +
      '{"identifier":"alice@example.com","service":"iMessage","is_group":false,"id":42}\n',
  );
  await Effect.runPromise(fixture.gestures.react("alice@example.com", "like"));
  expect(fixture.events).toContain("react --chat-id 42 --reaction like --json");
});

test("failed typing, read and parking identify the failed action in repeated alerts", async () => {
  for (const [action, call] of [
    ["key", "typing"],
    ["read", "read"],
    ["park", "read"],
  ] as const) {
    const fixture = await setup();
    fixture.failOn(action);
    for (let n = 0; n < 3; n++) {
      const task =
        call === "typing"
          ? fixture.gestures.typing("alice@example.com", "x", 0)
          : fixture.gestures.read("alice@example.com");
      await expect(Effect.runPromise(task)).rejects.toThrow(`${action} failed`);
    }
    const detail = action === "park" ? "park" : call;
    expect(fixture.alerts.some((alert) => alert.startsWith(`gestures: ${detail}:`))).toBe(true);
  }
});
