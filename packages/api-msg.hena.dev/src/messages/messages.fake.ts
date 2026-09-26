import { Effect } from "effect";
import type { IncomingMessage, Messages, OutgoingStatus } from "./messages.ts";

export const fakeMessages = (events: string[] = []) => {
  const bubbles: { handle: string; text: string }[] = [];
  const outgoing = new Map<string, OutgoingStatus>();
  let rows = Array.of<IncomingMessage>();
  const watchers = new Set<(row: IncomingMessage) => Effect.Effect<void, Error>>();
  const messages: Messages = {
    sendText: (handle, text) =>
      Effect.sync(() => {
        events.push("send");
        bubbles.push({ handle, text });
        outgoing.set(handle, { delivered: false, readAt: null });
        return { guid: `fake-${bubbles.length}` };
      }),
    lastOutgoingStatus: (handle) => Effect.sync(() => outgoing.get(handle)),
    after: (rowID) => Effect.sync(() => rows.filter((row) => row.id > rowID)),
    recent: (handle, since) =>
      Effect.sync(() => rows.filter((row) => row.handle === handle && row.createdAt >= since)),
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
  const text = (handle: string, content: string, createdAt: number) =>
    Effect.gen(function* () {
      const row: IncomingMessage = {
        id: (rows.at(-1)?.id ?? 0) + 1,
        guid: `incoming-${crypto.randomUUID()}`,
        handle,
        createdAt,
        text: content,
        fromMe: false,
      };
      rows.push(row);
      yield* Effect.forEach(watchers, (receive) => receive(row));
      return row;
    });
  return {
    messages,
    bubbles,
    events,
    status: (handle: string, status: OutgoingStatus) => outgoing.set(handle, status),
    text,
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
