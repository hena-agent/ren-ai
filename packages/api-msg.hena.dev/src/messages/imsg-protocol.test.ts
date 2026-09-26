import { Effect, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { expect, test } from "vitest";
import {
  accepted,
  afterPage,
  historyPage,
  messageRow,
  parseRpc,
  sendStatus,
  subscription,
} from "./imsg-protocol.ts";
import { at, decodeRequest, fixture, handle, isParams, raw } from "./imsg.fake.ts";
import { fakeMessages } from "./messages.fake.ts";
import { makeImsgMessages } from "./imsg.ts";

const bytes = (value: object | number | null) => new TextEncoder().encode(JSON.stringify(value));

test("RPC trust boundary rejects malformed frames and results without mistaking a send for delivery", () => {
  expect(() => parseRpc("{")).toThrow("JSON");
  for (const value of [
    null,
    {},
    { jsonrpc: "1.0" },
    { jsonrpc: "1.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: "bad", result: {} },
    { jsonrpc: "2.0", id: 1, error: { code: "-32001", message: "bad" } },
    { jsonrpc: "2.0", id: 1, error: { code: -32001, message: 1 } },
    { jsonrpc: "2.0", method: 1, params: {} },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", method: "message", params: null },
  ])
    expect(() => parseRpc(JSON.stringify(value))).toThrow("Invalid imsg RPC frame");
  expect(
    parseRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "uncertain" } }),
    ),
  ).toEqual({ id: 1, error: { code: -32001, message: "uncertain" } });
  expect(
    parseRpc(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { subscription: 1 } })),
  ).toEqual({ method: "message", params: { subscription: 1 } });
  for (const value of [
    null,
    {},
    { ...raw[0], id: "bad" },
    { ...raw[0], guid: null },
    { ...raw[0], chat_identifier: null },
    { ...raw[0], chat_id: null },
    { ...raw[0], created_at: "nonsense" },
    { ...raw[0], created_at: 12 },
    { ...raw[0], is_from_me: null },
    { ...raw[0], text: 1 },
  ])
    expect(() => messageRow(value)).toThrow("Invalid imsg message");
  expect(messageRow({ ...raw[0], text: null }).text).toBe("");
  for (const value of [
    null,
    {},
    { messages: [] },
    { messages: [], next_rowid: 1 },
    { messages: [], next_rowid: "bad", has_more: false },
    { messages: [], next_rowid: 1.5, has_more: false },
  ])
    expect(() => afterPage(value)).toThrow("Invalid imsg messages.after result");
  expect(() => historyPage(null)).toThrow("Invalid imsg messages.history result");
  expect(() => historyPage({ messages: false })).toThrow("Invalid imsg messages.history result");
  expect(() => subscription(null)).toThrow("Invalid imsg subscription");
  expect(() => subscription({ subscription: "bad" })).toThrow("Invalid imsg subscription");
  expect(() => subscription({ subscription: 1.5 })).toThrow("Invalid imsg subscription");
  expect(() => accepted(null)).toThrow("Invalid imsg send result");
  expect(() => accepted({ ok: false })).toThrow("Invalid imsg send result");
  expect(() => accepted({ ok: true, guid: 1 })).toThrow("Invalid imsg send result");
  expect(accepted({ ok: true })).toEqual({ guid: null });
  for (const value of [
    null,
    {},
    { send_state: "invalid" },
    { send_state: "invalid", status_fields: null },
    { send_state: "pending", status_fields: false },
  ])
    expect(() => sendStatus(value)).toThrow("Invalid imsg");
  expect(sendStatus({ send_state: "pending", status_fields: null })).toEqual({
    state: "pending",
    error: 0,
    dateRead: null,
  });
  expect(sendStatus({ send_state: "sent", status_fields: { error: 0 } }).state).toBe("sent");
  expect(
    sendStatus({ send_state: "delivered", status_fields: { error: true, date_read: 1 } }),
  ).toEqual({ state: "delivered", error: 0, dateRead: null });
});

test("the fake process validates stdin and implements every child handle method", async () => {
  for (const value of [
    null,
    {},
    { id: "1", method: "send", params: {} },
    { id: 1, params: {} },
    { id: 1, method: 1, params: {} },
    { id: 1, method: "send" },
    { id: 1, method: "send", params: [] },
    { id: 1, method: "send", params: { x: {} } },
    { id: 1, method: "send", params: { x: 1, y: {} } },
    1,
  ])
    expect(() => decodeRequest(bytes(value))).toThrow("Invalid fake request");
  expect(() => decodeRequest(new TextEncoder().encode("not-json"))).toThrow("JSON");
  expect(isParams({ a: "hi", b: 1, c: true })).toBe(true);
  expect(isParams(null)).toBe(false);
  expect(isParams(1)).toBe(false);
  expect(isParams({ a: 1, b: {} })).toBe(false);
  const f = fixture();
  expect(f.alerts).toEqual([]);
  expect(f.alertDetails).toEqual([]);
  await Effect.runPromise(f.alertsService.raise("manual"));
  expect(f.alertDetails).toEqual(["manual"]);
  f.replace([]);
  expect((await Effect.runPromise(f.inbound(handle, "first", Date.parse(at)))).id).toBe(1);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* f.spawner.spawn(ChildProcess.make("imsg", ["rpc"]));
        expect(yield* child.isRunning).toBe(true);
        yield* child.kill();
        expect(yield* child.isRunning).toBe(false);
        expect(yield* Stream.runCollect(child.getOutputFd(3))).toEqual([]);
        yield* Stream.run(Stream.make(new Uint8Array()), child.getInputFd(3));
        const reref = yield* child.unref;
        yield* reref;
        expect(f.spawned).toHaveLength(1);
      }),
    ),
  );
});

test("redacted probe rows stay identical to the recorded output", () => {
  expect(handle).toBe("<iphone>");
  expect(raw.map((row) => [row.guid, row.text])).toEqual([
    [
      "BB90B25A-85FC-492D-9E58-CA0EE9FAB596",
      "[imsg probe 1] 안녕하세요 👋 imsg로 보낸 테스트 메시지예요",
    ],
    ["09BDFB7D-3C64-40BC-B769-A0FB11B5C1CB", "[imsg probe 2] 안드로이드 번호 테스트"],
    ["90A70987-30BD-4CC5-BA10-B11C5EE76B9A", "1 텍스트"],
    ["2CDDBEF5-63F5-4D46-B274-C07EE7474351", "4 수정 전"],
    ["5BEB6BE5-CF8E-4C81-8FC4-55B5C0EF37C6", "5 취소할 메시지"],
  ]);
});

test("replayed imsg media, reaction and reply fields survive decoding without treating previews as apps", () => {
  const row = raw[2]!;
  expect(
    messageRow({
      ...row,
      attachments: [
        {
          original_path: "/Messages/picture.heic",
          mime_type: "image/heic",
          uti: "public.heic",
          missing: false,
        },
        {
          original_path: "/Messages/sticker.png",
          mime_type: "image/png",
          uti: "public.png",
          missing: false,
          is_sticker: true,
        },
        {
          original_path: "/Messages/clip.gif",
          mime_type: "image/gif",
          uti: "com.compuserve.gif",
          missing: false,
        },
        { mime_type: "audio/x-caf", uti: null, missing: true },
        { original_path: "/Messages/gone.heic", mime_type: null, missing: true },
        {},
      ],
    }).attachments,
  ).toEqual([
    { path: "/Messages/picture.heic", mimeType: "image/heic", uti: "public.heic", missing: false },
    { path: "/Messages/sticker.png", mimeType: "image/png", uti: "public.png", missing: false },
    {
      path: "/Messages/clip.gif",
      mimeType: "image/gif",
      uti: "com.compuserve.gif",
      missing: false,
    },
    { path: "", mimeType: "audio/x-caf", uti: null, missing: true },
    { path: "/Messages/gone.heic", mimeType: null, uti: null, missing: true },
    { path: "", mimeType: null, uti: null, missing: true },
  ]);
  for (const [type, emoji] of Object.entries({
    love: "❤️",
    like: "👍",
    dislike: "👎",
    laugh: "😂",
    emphasis: "‼️",
    question: "❓",
  })) {
    expect(
      messageRow({
        ...row,
        is_reaction: true,
        reaction_type: type,
        reacted_to_guid: raw[0]!.guid,
        is_reaction_add: true,
      }).tapback,
    ).toEqual({ emoji, targetGuid: raw[0]!.guid, added: true });
  }
  expect(
    messageRow({
      ...row,
      is_reaction: true,
      reaction_type: "custom",
      reaction_emoji: "🥲",
      reacted_to_guid: row.guid,
      is_reaction_add: false,
    }).tapback,
  ).toEqual({ emoji: "🥲", targetGuid: row.guid, added: false });
  expect(
    messageRow({
      ...row,
      is_reaction: true,
      reaction_type: "😮",
      reacted_to_guid: row.guid,
      is_reaction_add: true,
    }).tapback?.emoji,
  ).toBe("😮");
  expect(messageRow({ ...row, is_reaction: false }).tapback).toBeUndefined();
  expect(
    messageRow({ ...row, reply_to_guid: "ordinary-neighbor", thread_originator_guid: raw[0]!.guid })
      .replyToGuid,
  ).toBe(raw[0]!.guid);
  expect(
    messageRow({ ...row, reply_to_guid: "ordinary-neighbor", thread_originator_guid: null })
      .replyToGuid,
  ).toBeUndefined();
  expect(messageRow({ ...row, balloon_bundle_id: "com.apple.findmy.Location" }).payload).toBe(
    "location",
  );
  expect(messageRow({ ...row, balloon_bundle_id: "com.example.MessagesExtension" }).payload).toBe(
    "app",
  );
  expect(messageRow({ ...row, poll: { kind: "created" } }).payload).toBe("app");
  expect(
    messageRow({
      ...row,
      balloon_bundle_id: "com.apple.messages.URLBalloonProvider",
      text: "https://example.com",
    }),
  ).toMatchObject({ text: "https://example.com" });
  expect(
    messageRow({ ...row, balloon_bundle_id: "com.apple.messages.URLBalloonProvider" }).payload,
  ).toBeUndefined();
  expect(messageRow({ ...row, balloon_bundle_id: "" }).payload).toBeUndefined();
  expect(messageRow({ ...row, balloon_bundle_id: null }).payload).toBeUndefined();
  for (const invalid of [
    { attachments: null },
    { attachments: [false] },
    { attachments: [{ original_path: 12 }] },
    { attachments: [{ mime_type: 5 }] },
    { attachments: [{ uti: 5 }] },
    { attachments: [{ missing: 1 }] },
    { is_reaction: true },
    { is_reaction: true, reaction_type: 1, reacted_to_guid: row.guid, is_reaction_add: true },
    {
      is_reaction: true,
      reaction_type: "like",
      reaction_emoji: 1,
      reacted_to_guid: row.guid,
      is_reaction_add: true,
    },
    { is_reaction: true, reaction_type: "like", reacted_to_guid: 1, is_reaction_add: true },
    { is_reaction: true, reaction_type: "like", reacted_to_guid: row.guid, is_reaction_add: 1 },
    { thread_originator_guid: 1 },
    { balloon_bundle_id: 1 },
  ])
    expect(() => messageRow({ ...row, ...invalid })).toThrow("Invalid imsg");
});

test("the in-memory status checks each sent GUID, not the entire send history", async () => {
  const fake = fakeMessages();
  const first = await Effect.runPromise(fake.messages.sendText("first@example.com", "one"));
  const second = await Effect.runPromise(fake.messages.sendText("second@example.com", "two"));
  expect((await Effect.runPromise(fake.messages.status(first.guid!))).state).toBe("sent");
  expect((await Effect.runPromise(fake.messages.status(second.guid!))).state).toBe("sent");
  const pending = await Effect.runPromise(
    fake.outgoing("third@example.com", "pending", 0, "unknown"),
  );
  expect((await Effect.runPromise(fake.messages.status(pending.guid))).state).toBe("pending");
});

test("a non-advancing scan fails instead of looping; history limit grows beyond 50 rows", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        const large = Array.from({ length: 102 }, (_, index) => ({
          ...raw[3]!,
          id: index + 1,
          guid: `g-${index}`,
        }));
        f.replace(large);
        expect(yield* messages.recent(handle, 0)).toHaveLength(102);
        expect(
          f.commands.find((entry) => entry.method === "messages.history")?.params["limit"],
        ).toBe(103);
        f.stuck();
        expect((yield* messages.after(0).pipe(Effect.flip)).message).toContain("did not advance");
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("stopping after child exit releases the adapter without a live process", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        yield* messages.after(0);
        f.connections[0]!.close();
        yield* Effect.yieldNow;
        expect(f.connections).toHaveLength(1);
        expect(f.spawned).toMatchObject([
          { command: "imsg", args: ["rpc"], options: { stderr: "inherit" } },
        ]);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});
