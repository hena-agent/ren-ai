import { Deferred, Effect, Fiber, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, test } from "vitest";
import { makeMessagesUi } from "./messages-ui.ts";

const setup = async () => {
  const events: string[] = [];
  const alerts: string[] = [];
  let fail = "";
  let keyPause: Effect.Effect<void> = Effect.void;
  let chats = '{"id":42,"identifier":"alice@example.com","service":"iMessage","is_group":false}\n';
  let block: Effect.Effect<void> = Effect.void;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) throw Error("Unexpected pipeline");
      if (command.command !== "imsg") {
        expect(command.command).toBe("/usr/bin/osascript");
        expect(command.args[0]).toMatch(/\/messages-ui\.applescript$/);
      }
      const action = command.command === "imsg" ? command.args[0]! : command.args[1]!;
      events.push(
        `${action} ${command.args.slice(command.command === "imsg" ? 1 : 2).join(" ")}`.trim(),
      );
      if (action === fail)
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "test",
            method: action,
            description: `${action} failed`,
          }),
        );
      if (action === "react") yield* block;
      if (action === "key") yield* keyPause;
      return ChildProcessSpawner.makeHandle({
        stdout: Stream.make(new TextEncoder().encode(action === "chats" ? chats : "ok")),
        stderr: Stream.empty,
        all: Stream.empty,
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const gestures = await Effect.runPromise(
    makeMessagesUi({
      raise: (name, detail) =>
        Effect.sync(() => {
          alerts.push(`${name}: ${detail}`);
        }),
      clear: (name) =>
        Effect.sync(() => {
          alerts.push(`clear: ${name}`);
        }),
    }).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
  );
  return {
    gestures,
    events,
    alerts,
    failOn: (action: string) => {
      fail = action;
    },
    pauseKey: (effect: Effect.Effect<void>) => {
      keyPause = effect;
    },
    setChats: (output: string) => {
      chats = output;
    },
    blockReact: (effect: Effect.Effect<void>) => {
      block = effect;
    },
  };
};

test("typing checks the chat, guards each character, clears and parks", async () => {
  const { gestures, events } = await setup();
  expect(await Effect.runPromise(gestures.typing("alice@example.com", "hi", 0))).toBe(true);
  expect(events).toEqual([
    "ensure",
    "chats --limit 10000 --json",
    "open sms://open?groupid=alice%40example.com",
    "key h",
    "key i",
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
});

test("typing spends its allotted time even without UI contention", async () => {
  const { gestures } = await setup();
  const started = Date.now();
  expect(await Effect.runPromise(gestures.typing("alice@example.com", "x", 60))).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  expect(Date.now() - started).toBeLessThan(105);
});

test("time spent typing characters counts toward the typing duration", async () => {
  const fixture = await setup();
  fixture.pauseKey(Effect.sleep(40));
  const started = Date.now();
  await Effect.runPromise(fixture.gestures.typing("alice@example.com", "x", 120));
  expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  expect(Date.now() - started).toBeLessThan(185);
});

test("typing stops on a failed guard and still parks", async () => {
  const fixture = await setup();
  fixture.failOn("key");
  await expect(
    Effect.runPromise(fixture.gestures.typing("alice@example.com", "hi", 0)),
  ).rejects.toThrow("key failed");
  expect(fixture.events).toEqual([
    "ensure",
    "chats --limit 10000 --json",
    "open sms://open?groupid=alice%40example.com",
    "key h",
    "clear sms://open?groupid=alice%40example.com",
    "park",
  ]);
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

test("one lock serializes other Conversations and busy typing waits without touching UI", async () => {
  const fixture = await setup();
  const gate = await Effect.runPromise(Deferred.make<void>());
  fixture.blockReact(Deferred.await(gate));
  const reaction = Effect.runFork(fixture.gestures.react("alice@example.com", "love"));
  while (!fixture.events.some((event) => event.startsWith("react ")))
    await new Promise((resolve) => setTimeout(resolve, 1));
  const started = Date.now();
  expect(await Effect.runPromise(fixture.gestures.typing("bob@example.com", "x", 60))).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  const read = Effect.runFork(fixture.gestures.read("alice@example.com"));
  expect(fixture.events.filter((event) => event === "ensure")).toHaveLength(1);
  await Effect.runPromise(Deferred.succeed(gate, undefined));
  await Effect.runPromise(Fiber.join(reaction));
  await Effect.runPromise(Fiber.join(read));
  expect(fixture.events.filter((event) => event === "park")).toHaveLength(2);
  expect(fixture.events).toContain("react --chat-id 42 --reaction love --json");
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
