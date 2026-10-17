import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { noIMessage, openHistory, uriOf } from "./history.ts";
import { incoming, service } from "../../test/bridge.test-helper.ts";
import type { BridgeMessage } from "./bridge-protocol.ts";

const them = "tel:+821012345678";
const handle = "+821012345678";
const directories: string[] = [];

const open = () => {
  const directory = mkdtempSync(join(tmpdir(), "imsg-history-"));
  directories.push(directory);
  return { history: openHistory(join(directory, "history.sqlite"), "hi@renai.im"), directory };
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

interface Envelope {
  readonly guid?: string;
  readonly sender?: string | null;
  readonly participants?: ReadonlyArray<string> | null;
  readonly sentAt?: number;
}
const envelope = (fields: Envelope) => ({
  guid: crypto.randomUUID().toUpperCase(),
  sender: them,
  participants: [them, service],
  sentAt: 1_000,
  ...fields,
});
const text = (fields: Envelope): BridgeMessage => ({
  ...incoming(them, "x", 1_000),
  ...envelope(fields),
});
const reaction = (target: string): BridgeMessage => ({
  ...envelope({}),
  kind: "tapback",
  target,
  emoji: "😂",
  added: true,
});
const edit = (target: string, content: string, fields: Envelope = {}): BridgeMessage => ({
  ...envelope(fields),
  kind: "edit",
  target,
  text: content,
});
const unsend = (target: string, fields: Envelope = {}): BridgeMessage => ({
  ...envelope(fields),
  kind: "unsend",
  target,
});
const acknowledgement = (
  kind: "delivered" | "read",
  guid: string,
  fields: Envelope = {},
): BridgeMessage => ({
  ...envelope(fields),
  kind,
  guid,
});

test("handles convert between Apple URIs and the application's handles", () => {
  const { history } = open();
  expect(history.apply(incoming("mailto:Someone@Example.com", "hello", 1))?.handle).toBe(
    "someone@example.com",
  );
  expect(history.apply(incoming(them, "hello", 2))?.handle).toBe(handle);
  history.close();
  expect(uriOf("Someone@Example.com")).toBe("mailto:someone@example.com");
  expect(uriOf(handle)).toBe(them);
});

test("only one-to-one conversations with the service handle become rows", () => {
  const { history } = open();
  expect(history.lastID()).toBe(0);
  const message = incoming(them, "hello", 1_000, {
    attachments: [
      { path: "/state/attachments/A-0.heic", mime: "image/heic", uti: "public.heic" },
      { path: null, mime: "video/quicktime", uti: "com.apple.quicktime-movie" },
    ],
    replyTo: "ORIGINAL",
    payload: "location",
  });
  const row = history.apply(message);
  expect(row).toEqual({
    id: row?.id,
    guid: message.guid,
    handle,
    createdAt: 1_000,
    text: "hello",
    fromMe: false,
    attachments: [
      {
        path: "/state/attachments/A-0.heic",
        mimeType: "image/heic",
        uti: "public.heic",
        missing: false,
      },
      { path: "", mimeType: "video/quicktime", uti: "com.apple.quicktime-movie", missing: true },
    ],
    replyToGuid: "ORIGINAL",
    payload: "location",
  });
  expect(history.apply(message)).toBeUndefined();
  const ignored = [
    { participants: [them, service, "tel:+15550100"] },
    { participants: [them, "mailto:other@renai.im"] },
    { participants: [service, service] },
    { participants: null },
    { sender: "tel:+15550100" },
  ];
  for (const fields of ignored) expect(history.apply(text(fields))).toBeUndefined();
  const copy = history.apply(
    incoming(service, "typed on another device", 2_000, {
      participants: [them, "MAILTO:HI@RENAI.IM"],
    }),
  );
  expect(copy).toMatchObject({ fromMe: true, handle, text: "typed on another device" });
  expect(history.status(copy!.guid)).toEqual({ state: "sent", error: 0, dateRead: null });
  expect(history.after(0).map((item) => item.guid)).toEqual([message.guid, copy!.guid]);
  expect(history.after(row!.id).map((item) => item.guid)).toEqual([copy!.guid]);
  expect(history.recent(handle, 1_500).map((item) => item.guid)).toEqual([copy!.guid]);
  expect(history.lastID()).toBe(copy!.id);
});

test("tapbacks are rows, and only authors can edit or unsend", () => {
  const { history } = open();
  const original = history.apply(incoming(them, "first", 1_000))!;
  const tapback = history.apply(reaction("OURS"));
  expect(tapback).toMatchObject({
    text: "",
    tapback: { emoji: "😂", targetGuid: "OURS", added: true },
  });
  expect(history.lastIncoming(handle)?.guid).toBe(original.guid);
  expect(history.lastIncoming(handle, original.id)).toBeUndefined();
  history.apply(edit(original.guid, "edited", { sender: service }));
  expect(history.recent(handle, 0)[0]?.text).toBe("first");
  history.apply(edit(original.guid, "edited"));
  expect(history.recent(handle, 0)[0]?.text).toBe("edited");
  history.apply(unsend(original.guid));
  expect(history.recent(handle, 0)[0]?.text).toBe("");
  expect(history.apply(unsend(original.guid, { participants: null }))).toBeUndefined();
});

test("bounded catch-up preserves cursor order across a large unrelated backlog", () => {
  const { history, directory } = open();
  try {
    // Seed the query fixture in one commit instead of 10,000 durable event writes.
    const fixture = new DatabaseSync(join(directory, "history.sqlite"));
    try {
      fixture.exec(`WITH RECURSIVE backlog(i) AS (
        VALUES(0) UNION ALL SELECT i + 1 FROM backlog WHERE i < 9999
      ) INSERT INTO message (guid, handle, created_at, text, from_me)
        SELECT 'backlog-' || i, 'user-' || i || '@example.com', i, 'history', 0 FROM backlog`);
    } finally {
      fixture.close();
    }
    const target = history.outgoing("target", handle, "latest inserted", 1);
    history.settle(target.guid, "sent");
    const first = history.after(9_999, 1);
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(10_000);
    expect(history.after(first[0]!.id, 1)).toEqual([target]);
    expect(history.after(target.id, 1)).toEqual([]);
    expect(history.recent(handle, 0)).toEqual([target]);
    expect(history.lastOutgoing(handle)).toEqual({ state: "sent", error: 0, readAt: null });
  } finally {
    history.close();
  }
});

test("outgoing rows settle once and receipts mark them delivered and read", () => {
  const { history, directory } = open();
  const first = history.outgoing("A", handle, "one", 1_000);
  expect(first).toMatchObject({ guid: "A", fromMe: true, text: "one" });
  expect(history.status("A")).toEqual({ state: "pending", error: 0, dateRead: null });
  expect(history.lastOutgoing(handle)).toEqual({ state: "pending", error: 0, readAt: null });
  history.settle("A", "sent");
  history.settle("A", "failed", noIMessage);
  expect(history.status("A").state).toBe("sent");
  history.outgoing("B", handle, "two", 2_000);
  history.settle("B", "failed", noIMessage);
  expect(history.lastOutgoing(handle, 1_500)).toEqual({
    state: "failed",
    error: noIMessage,
    readAt: null,
  });
  expect(history.lastOutgoing(handle, 3_000)).toBeUndefined();
  history.outgoing("C", handle, "three", 3_000);
  for (const receipt of [
    acknowledgement("delivered", "A", { sender: service }),
    acknowledgement("delivered", "A", { sender: null }),
    acknowledgement("delivered", "missing"),
    acknowledgement("delivered", "A", { sender: "tel:+15550100" }),
  ])
    history.apply(receipt);
  expect(history.status("A").state).toBe("sent");
  history.apply(acknowledgement("delivered", "B"));
  expect(history.status("B")).toEqual({ state: "delivered", error: 0, dateRead: null });
  history.apply(acknowledgement("read", "B", { sentAt: 5_000 }));
  expect(history.status("A").dateRead).toBe(5_000);
  expect(history.status("C").dateRead).toBeNull();
  history.apply(acknowledgement("read", "C", { sentAt: 6_000 }));
  expect([history.status("A").dateRead, history.status("C")]).toEqual([
    5_000,
    { state: "delivered", error: 0, dateRead: 6_000 },
  ]);
  expect(history.status("missing")).toEqual({ state: "pending", error: 0, dateRead: null });
  history.close();
  const reopened = openHistory(join(directory, "history.sqlite"), "hi@renai.im");
  expect(reopened.after(0).map((row) => row.guid)).toEqual(["A", "B", "C"]);
  reopened.close();
});
