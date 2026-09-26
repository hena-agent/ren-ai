import { Effect, Fiber, Option, Queue, Result, Scope } from "effect";
import type { IncomingMessage, Messages } from "./messages.ts";
import {
  accepted,
  afterPage,
  historyPage,
  messageRow,
  sendStatus,
  subscription,
} from "./imsg-protocol.ts";
import { imsgRpc } from "./imsg-rpc.ts";

interface Alerts {
  raise(name: string, detail?: string): Effect.Effect<void>;
  clear(name: string): Effect.Effect<void>;
}

const pageSize = 100;

/** Scoped adapter: keep its scope alive for as long as Messages is in use. */
export const makeImsgMessages = (alerts: Alerts) =>
  Effect.gen(function* () {
    const rpc = yield* imsgRpc;
    const lifetime = yield* Scope.Scope;
    let sendFailures = 0;
    const after = (rowID: number) =>
      Effect.gen(function* () {
        const rows: Array<IncomingMessage & { chatID: number }> = [];
        let cursor = rowID;
        for (;;) {
          const reply = yield* rpc.request("messages.after", {
            since_rowid: cursor,
            limit: pageSize,
            attachments: true,
            include_reactions: true,
          });
          const page = yield* Effect.try(() => afterPage(reply));
          rows.push(...page.rows);
          if (!page.more) return rows;
          if (page.next <= cursor)
            return yield* Effect.fail(new Error("imsg messages.after did not advance"));
          cursor = page.next;
        }
      });
    const status = (guid: string) =>
      Effect.flatMap(rpc.request("message.send_status", { guid }), (value) =>
        Effect.map(
          Effect.try(() => sendStatus(value)),
          (result) => {
            return {
              state: result.state,
              error: result.error,
              dateRead: result.dateRead === null ? null : Date.parse(result.dateRead),
            };
          },
        ),
      );
    const checkWatch = (cursor: number, date: number) =>
      Effect.gen(function* () {
        // Silence is normal; only a missed row or replaced database is a stalled watch.
        const reply = yield* rpc.request("messages.after", {
          since_rowid: Math.max(0, cursor - 1),
          limit: 2,
          include_reactions: true,
        });
        const probe = yield* Effect.try(() => afterPage(reply));
        const marker = probe.rows[0];
        if ((cursor > 0 && marker?.createdAt !== date) || probe.rows.some((row) => row.id > cursor))
          yield* Effect.fail(new Error());
      });
    const messages: Messages = {
      after,
      status,
      sendText: (handle, text) =>
        Effect.gen(function* () {
          const outcome = yield* rpc
            .request("send", {
              to: handle,
              text,
              service: "imessage",
              allow_sms_fallback: false,
            })
            .pipe(
              Effect.flatMap((value) => Effect.try(() => accepted(value))),
              Effect.result,
            );
          if (Result.isFailure(outcome)) {
            sendFailures++;
            if (sendFailures >= 3) yield* alerts.raise("imsg-sends", "Repeated imsg send failures");
            return yield* Effect.fail(
              new Error("imsg send uncertain; reconcile outgoing rows before retry"),
            );
          }
          sendFailures = 0;
          yield* alerts.clear("imsg-sends");
          return outcome.success;
        }),
      textStatus: (handle, since) =>
        Effect.gen(function* () {
          const rows = yield* after(0);
          const last = rows
            .filter((row) => row.fromMe && row.handle === handle && row.createdAt >= since)
            .at(-1);
          if (!last) return "unknown";
          const result = yield* status(last.guid);
          if (result.error === 22) return "no_imessage";
          return result.state === "sent" || result.state === "delivered" ? "sent" : "unknown";
        }),
      recent: (handle, since) =>
        Effect.gen(function* () {
          // Find the numeric chat ID from the row scan; a chat GUID isn't a Handle.
          const all = yield* after(0);
          const match = all.find((row) => row.handle === handle);
          if (!match) return [];
          const chatID = match.chatID;
          // history has no offset/cursor. Its date filter plus a limit above the
          // current scan's chat size includes the entire edit window, not just 50 rows.
          const reply = yield* rpc.request("messages.history", {
            chat_id: chatID,
            start: new Date(since).toISOString(),
            limit: Math.max(pageSize, all.length + 1),
            attachments: true,
          });
          const rows = yield* Effect.try(() => historyPage(reply));
          return rows.filter((row) => row.createdAt >= since).toSorted((a, b) => a.id - b.id);
        }),
      follow: (rowID, receive) =>
        Effect.gen(function* () {
          let cursor = rowID;
          let lastDate = 0;
          let restarts = 0;
          const replay = (checkReplacement: boolean) =>
            Effect.gen(function* () {
              const all = yield* after(0);
              if (lastDate === 0) lastDate = all.find((row) => row.id === cursor)?.createdAt ?? 0;
              if (
                checkReplacement &&
                !all.some((row) => row.id === cursor && row.createdAt === lastDate)
              ) {
                // ROWIDs are local to chat.db; reconcile by date after replacement.
                cursor = 0;
              }
              for (const row of all) {
                if (row.id <= cursor || (checkReplacement && row.createdAt < lastDate)) continue;
                yield* receive(row);
                cursor = row.id;
                lastDate = row.createdAt;
              }
            });
          const watch = Effect.forever(
            Effect.gen(function* () {
              yield* replay(restarts > 0);
              const reply = yield* rpc.request("watch.subscribe", {
                since_rowid: cursor === 0 ? -1 : cursor,
                attachments: true,
                include_reactions: true,
                debounce_ms: 500,
              });
              const id = yield* Effect.try(() => subscription(reply));
              for (;;) {
                const next = yield* Queue.take(rpc.notices).pipe(
                  Effect.timeoutOption("30 seconds"),
                );
                if (Option.isNone(next)) {
                  yield* checkWatch(cursor, lastDate);
                  continue;
                }
                const notice = next.value;
                if ("method" in notice && notice.method === "watch.disconnected")
                  yield* Effect.fail(new Error());
                if (!("method" in notice) || notice.params["subscription"] !== id) continue;
                if (notice.method === "watch.overflow") break;
                if (notice.method !== "message") continue;
                const row = yield* Effect.try(() => messageRow(notice.params["message"]));
                if (row.id <= cursor) continue;
                yield* receive(row);
                cursor = row.id;
                lastDate = row.createdAt;
                restarts = 0;
                yield* alerts.clear("imsg-watch");
              }
            }).pipe(
              Effect.catch(() => alerts.raise("imsg-watch", "imsg watch stalled or disconnected")),
              Effect.andThen(
                Effect.gen(function* () {
                  restarts++;
                  if (restarts >= 3)
                    yield* alerts.raise("imsg-watch", "imsg watch keeps restarting");
                  yield* rpc.restart;
                  yield* Effect.sleep("1 second");
                }),
              ),
            ),
          );
          const fiber = yield* Effect.forkIn(watch, lifetime);
          return () => {
            Effect.runFork(Fiber.interrupt(fiber));
          };
        }),
    };
    return messages;
  });
