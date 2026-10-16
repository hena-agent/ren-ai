import { Effect } from "effect";
import { expect, test } from "vitest";
import { failure, setup } from "../../test/messages-ui.test-helper.ts";

test("gestures reuse chat discovery and verify a cached chat before every action", async () => {
  const f = await setup();
  for (let i = 0; i < 10; i++) await Effect.runPromise(f.gestures.read("alice@example.com"));
  expect(f.events.filter((e) => e.startsWith("chats "))).toHaveLength(1);
  expect(f.events.filter((e) => e.startsWith("group "))).toHaveLength(9);
  f.setChats('{"id":42,"identifier":"other@example.com","service":"iMessage","is_group":false}');
  expect(await failure(f.gestures.react("alice@example.com", "love"))).toContain("No direct");
  expect(f.events.some((e) => e.startsWith("react "))).toBe(false);
});

test("discovery grows beyond the old 10000-chat limit and seeds other Handle lookups", async () => {
  const f = await setup();
  f.setChats(
    Array.from({ length: 10001 }, (_, i) =>
      JSON.stringify({
        id: i + 1,
        identifier: `user-${i}@example.com`,
        service: "iMessage",
        is_group: false,
      }),
    ).join("\n"),
  );
  await Effect.runPromise(f.gestures.react("user-10000@example.com", "like"));
  expect(f.events).toContain("react --chat-id 10001 --reaction like --json");
  const discoveries = f.events.filter((e) => e.startsWith("chats ")).length;
  await Effect.runPromise(f.gestures.read("user-1@example.com"));
  expect(f.events.filter((e) => e.startsWith("chats "))).toHaveLength(discoveries);
  expect(f.events).toContain("group --chat-id 2 --json");
});

test("cached chat verification errors invalidate discovery without performing the action", async () => {
  const f = await setup();
  await Effect.runPromise(f.gestures.read("alice@example.com"));
  f.exitOn("group", "chat missing");
  expect(await failure(f.gestures.react("alice@example.com", "like"))).toContain("chat missing");
  f.exitOn("", "");
  f.setChats('{"id":77,"identifier":"alice@example.com","service":"iMessage","is_group":false}');
  await Effect.runPromise(f.gestures.react("alice@example.com", "like"));
  expect(f.events.filter((e) => e.startsWith("react "))).toEqual([
    "react --chat-id 77 --reaction like --json",
  ]);
});
