import { Clock, Effect } from "effect";
import type { IncomingMessage, Messages, OutgoingStatus } from "./messages.ts";

export const fakeMessages = (events: string[] = []) => {
  const bubbles: { handle: string; text: string }[] = [];
  const lastStatuses = new Map<string, OutgoingStatus>();
  let rows = Array.of<IncomingMessage>();
  const sendStatuses = new Map<string, "sent" | "delivered" | "failed" | "unknown">();
  const watchers = new Set<(row: IncomingMessage) => Effect.Effect<void, Error>>();
  const statuses = new Map<string, "sent" | "no_imessage" | "unknown">();
  const rejected = new Set<string>();
  const statusFailures = new Set<string>();
  const statusChecks: string[] = [];
  const messages: Messages = {
    sendText: (handle, text) =>
      Effect.suspend(() =>
        rejected.has(handle)
          ? Effect.fail(new Error("imsg send timed out"))
          : Effect.gen(function* () {
              events.push("send");
              bubbles.push({ handle, text });
              lastStatuses.set(handle, { delivered: false, readAt: null });
              const row = yield* outgoing(
                handle,
                text,
                yield* Clock.currentTimeMillis,
                "sent",
                `fake-${bubbles.length}`,
              );
              return { guid: row.guid };
            }),
      ),
    textStatus: (handle) =>
      Effect.suspend(() => {
        statusChecks.push(handle);
        return statusFailures.has(handle)
          ? Effect.fail(new Error("Messages status temporarily unavailable"))
          : Effect.sync(
              () =>
                statuses.get(handle) ??
                (bubbles.some((bubble) => bubble.handle === handle) ? "sent" : "unknown"),
            );
      }),
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
    after: (rowID) => Effect.sync(() => rows.filter((row) => row.id > rowID)),
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
        id: (rows.at(-1)?.id ?? 0) + 1,
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
        id: (rows.at(-1)?.id ?? 0) + 1,
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
    rejected,
    statusFailures,
    statusChecks,
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
    replace: (replacement: ReadonlyArray<IncomingMessage>) =>
      Effect.sync(() => (rows = [...replacement])),
  };
};
