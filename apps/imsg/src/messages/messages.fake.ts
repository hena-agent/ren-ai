import { Clock, Effect } from "effect";
import type { IncomingMessage, Messages } from "./messages.ts";
import type { OutgoingStatus } from "../gateway/protocol.ts";
import { imageData } from "./images.ts";

export const fakeMessages = (events: string[] = []) => {
  const bubbles: { handle: string; text: string }[] = [];
  const lastStatuses = new Map<string, OutgoingStatus>();
  let rows = Array.of<IncomingMessage>();
  // One Messages database never reuses a ROWID; only a replaced database restarts its numbering.
  let lastID = 0;
  const sendStatuses = new Map<string, "sent" | "delivered" | "failed" | "unknown">();
  const watchers = new Set<(row: IncomingMessage) => Effect.Effect<void, Error>>();
  const statuses = new Map<string, "sent" | "no_imessage" | "unknown">();
  const messages: Messages = {
    image: imageData,
    sendText: (handle, text, attemptID) =>
      Effect.gen(function* () {
        if (attemptID && sendStatuses.has(attemptID)) return { guid: attemptID };
        events.push("send");
        bubbles.push({ handle, text });
        lastStatuses.set(handle, { delivered: false, readAt: null });
        const row = yield* outgoing(
          handle,
          text,
          yield* Clock.currentTimeMillis,
          "sent",
          attemptID ?? `fake-${bubbles.length}`,
        );
        return { guid: row.guid };
      }),
    resolveSend: (attemptID) =>
      Effect.sync(() => {
        if (!sendStatuses.has(attemptID)) sendStatuses.set(attemptID, "failed");
        return sendStatuses.get(attemptID)!;
      }),
    textStatus: (handle) =>
      Effect.sync(
        () =>
          statuses.get(handle) ??
          (bubbles.some((bubble) => bubble.handle === handle) ? "sent" : "unknown"),
      ),
    lastOutgoingStatus: (handle) => Effect.sync(() => lastStatuses.get(handle)),
    status: (guid) =>
      Effect.sync(() => {
        const state = sendStatuses.get(guid);
        return {
          state: state && state !== "unknown" ? state : "pending",
          error: 0,
          dateRead: null,
        };
      }),
    after: (rowID, limit) =>
      Effect.sync(() => rows.filter((row) => row.id > rowID).slice(0, limit)),
    recent: (handle, since) =>
      Effect.sync(() => rows.filter((row) => row.handle === handle && row.createdAt >= since)),
    sendStatus: (guid) => Effect.sync(() => sendStatuses.get(guid) ?? "unknown"),
    follow: (rowID, receive) =>
      Effect.gen(function* () {
        watchers.add(receive);
        yield* Effect.forEach(
          rows.filter((row) => row.id > rowID),
          receive,
        );
        return () => watchers.delete(receive);
      }),
  };
  const text = (
    handle: string,
    content: string,
    createdAt: number,
    extra: Pick<IncomingMessage, "attachments" | "tapback" | "replyToGuid" | "payload"> = {},
  ) =>
    Effect.gen(function* () {
      const row: IncomingMessage = {
        id: ++lastID,
        guid: `incoming-${crypto.randomUUID()}`,
        handle,
        createdAt,
        text: content,
        fromMe: false,
        ...extra,
      };
      rows.push(row);
      yield* Effect.forEach(watchers, (receive) => receive(row));
      return row;
    });
  const outgoing = (
    handle: string,
    content: string,
    createdAt: number,
    status: "sent" | "delivered" | "failed" | "unknown" = "sent",
    guid = `outgoing-${crypto.randomUUID()}`,
  ) =>
    Effect.gen(function* () {
      const row: IncomingMessage = {
        id: ++lastID,
        guid,
        handle,
        createdAt,
        text: content,
        fromMe: true,
      };
      rows.push(row);
      sendStatuses.set(guid, status);
      yield* Effect.forEach(watchers, (receive) => receive(row));
      return row;
    });
  return {
    messages,
    bubbles,
    events,
    statuses,
    status: (handle: string, status: OutgoingStatus) => lastStatuses.set(handle, status),
    text,
    outgoing,
    settle: (guid: string, status: "sent" | "delivered" | "failed" | "unknown") =>
      Effect.sync(() => sendStatuses.set(guid, status)),
    redeliver: (row: IncomingMessage) => Effect.forEach(watchers, (receive) => receive(row)),
    edit: (guid: string, content: string) =>
      Effect.sync(() => {
        rows = rows.map((row) => (row.guid === guid ? { ...row, text: content } : row));
      }),
    unsend: (guid: string) =>
      Effect.sync(() => {
        rows = rows.map((row) => (row.guid === guid ? { ...row, text: "" } : row));
      }),
    remove: (guid: string) =>
      Effect.sync(() => {
        rows = rows.filter((row) => row.guid !== guid);
      }),
    replace: (replacement: ReadonlyArray<IncomingMessage>) =>
      Effect.sync(() => {
        rows = [...replacement];
        lastID = Math.max(0, ...replacement.map((row) => row.id));
      }),
  };
};
