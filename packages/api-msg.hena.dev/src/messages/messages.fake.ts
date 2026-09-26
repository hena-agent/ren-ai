import { Effect } from "effect";
import type { IncomingMessage, Messages } from "./messages.ts";

export const fakeMessages = (events: string[] = []) => {
  const bubbles: { handle: string; text: string }[] = [];
  let rows = Array.of<IncomingMessage>();
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
          : Effect.sync(() => {
              events.push("send");
              bubbles.push({ handle, text });
              return { guid: `fake-${bubbles.length}` };
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
    status: (guid) =>
      Effect.sync(() => ({
        state: bubbles.some((_, index) => `fake-${index + 1}` === guid)
          ? ("delivered" as const)
          : ("pending" as const),
        error: 0,
        dateRead: null,
      })),
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
    statuses,
    rejected,
    statusFailures,
    statusChecks,
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
