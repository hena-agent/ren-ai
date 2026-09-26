import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { makeImsgMessages } from "./imsg.ts";
import { fakeMessages } from "./messages.fake.ts";
import type { IncomingMessage, Messages } from "./messages.ts";

import { at, fixture, handle, raw } from "./imsg.fake.ts";

const contract = (
  name: string,
  run: (
    scenario: (
      messages: Messages,
      text: (
        handle: string,
        content: string,
        date: number,
      ) => Effect.Effect<IncomingMessage, Error>,
    ) => Effect.Effect<void, Error>,
  ) => Promise<void>,
) => {
  test(`${name}: send, follow, after, recent and status share the same contract`, async () => {
    await run((messages, text) =>
      Effect.gen(function* () {
        const guid = (yield* messages.sendText(handle, "hi")).guid;
        expect(guid).toBeTruthy();
        expect((yield* messages.status(guid!)).state).toBe("delivered");
        expect((yield* messages.status("not-yet-present")).state).toBe("pending");
        expect(yield* messages.textStatus(handle, 0)).toBe("sent");
        expect(yield* messages.textStatus("absent", 0)).toBe("unknown");
        const incoming: IncomingMessage[] = [];
        const stop = yield* messages.follow(0, (row) =>
          Effect.sync(() => {
            incoming.push(row);
          }),
        );
        const row = yield* text(handle, "hello", Date.parse(at));
        expect((yield* messages.after(0)).some((item) => item.guid === row.guid)).toBe(true);
        expect(
          (yield* messages.recent(handle, Date.parse(at))).some((item) => item.guid === row.guid),
        ).toBe(true);
        for (let i = 0; i < 30 && !incoming.some((item) => item.guid === row.guid); i++)
          yield* Effect.yieldNow;
        expect(incoming.some((item) => item.guid === row.guid)).toBe(true);
        stop();
      }),
    );
  });
};

contract("memory", (scenario) => {
  const f = fakeMessages();
  return Effect.runPromise(scenario(f.messages, f.text));
});

contract("imsg replay", (scenario) => {
  const f = fixture();
  f.status("not-yet-present", "pending", 0);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        yield* scenario(messages, f.inbound);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

const until = (ready: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100 && !ready(); i++) yield* Effect.yieldNow;
    expect(ready()).toBe(true);
  });

const follow = (messages: Messages, rowID: number, seen: IncomingMessage[]) =>
  messages.follow(rowID, (row) =>
    Effect.sync(() => {
      seen.push(row);
    }),
  );

const followReady = (f: ReturnType<typeof fixture>, rowID: number) =>
  Effect.gen(function* () {
    const messages = yield* makeImsgMessages(f.alertsService);
    const seen: IncomingMessage[] = [];
    const stop = yield* follow(messages, rowID, seen);
    yield* until(() => f.commands.some((command) => command.method === "watch.subscribe"));
    return { seen, stop };
  });

const restartAfterAlert = (f: ReturnType<typeof fixture>) =>
  Effect.gen(function* () {
    yield* until(() => f.alerts.includes("raise:imsg-watch"));
    yield* TestClock.adjust("1 second");
    yield* until(() => f.connections.length === 2);
  });

const recoverReplacement = (f: ReturnType<typeof fixture>, seen: IncomingMessage[], guid: string) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("30 seconds");
    yield* until(() => f.alerts.includes("raise:imsg-watch"));
    yield* TestClock.adjust("1 second");
    yield* until(() => seen.some((row) => row.guid === guid));
  });

test("watch overflow catches up, ignores duplicates and survives a replaced database", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { seen, stop } = yield* followReady(f, 6);
        expect(seen.map((row) => row.id)).toEqual([9, 10]);
        const ignored = { ...raw[3]!, id: 11, guid: "wrong-subscription" };
        f.connections[0]!.notify("message", { subscription: 99, message: ignored });
        f.connections[0]!.notify("unrelated", { subscription: 1, message: ignored });
        yield* Effect.yieldNow;
        expect(seen).toHaveLength(2);
        f.connections[0]!.notify("message", { subscription: 1, message: raw[4] });
        f.connections[0]!.notify("message", { subscription: 99, message: raw[4] });
        f.connections[0]!.notify("watch.overflow", {
          subscription: 1,
          resume_after_rowid: 9,
          terminal: true,
        });
        yield* TestClock.adjust("1 second");
        yield* until(() => f.connections.length === 2);
        expect(seen.map((row) => row.id)).toEqual([9, 10]);
        expect(
          f.commands
            .filter((entry) => entry.method === "watch.subscribe")
            .every(
              (entry) =>
                entry.params["attachments"] === true && entry.params["include_reactions"] === true,
            ),
        ).toBe(true);
        const replacement = [
          { ...raw[3]!, id: 1, created_at: "2026-09-25T12:04:00.000Z", guid: "replacement-guid" },
        ];
        f.replace(replacement);
        yield* until(
          () => f.commands.filter((command) => command.method === "watch.subscribe").length === 2,
        );
        f.connections[1]!.notify("watch.overflow", {
          subscription: 1,
          resume_after_rowid: 0,
          terminal: true,
        });
        yield* TestClock.adjust("1 second");
        yield* until(() => seen.some((row) => row.guid === "replacement-guid"));
        expect(
          f.commands.some(
            (command) =>
              command.method === "watch.subscribe" && command.params["since_rowid"] === 1,
          ),
        ).toBe(true);
        stop();
        yield* Effect.yieldNow;
        f.connections.at(-1)!.notify("message", { subscription: 1, message: ignored });
        yield* Effect.yieldNow;
        expect(seen.map((row) => row.guid)).not.toContain("wrong-subscription");
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("a stalled watch alerts, restarts the child, and clears only after a healthy message", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { seen, stop } = yield* followReady(f, 10);
        yield* TestClock.adjust("30 seconds");
        expect(f.alerts).not.toContain("raise:imsg-watch");
        expect(f.connections).toHaveLength(1);
        yield* until(() =>
          f.commands.some(
            (entry) => entry.method === "messages.after" && entry.params["since_rowid"] === 9,
          ),
        );
        expect(
          f.commands.find(
            (entry) => entry.method === "messages.after" && entry.params["limit"] === 2,
          )?.params,
        ).toMatchObject({ since_rowid: 9, include_reactions: true });
        yield* TestClock.adjust("1 second");
        expect(f.alerts).not.toContain("raise:imsg-watch");
        const missed = {
          ...raw[3]!,
          id: 11,
          guid: "missed-row",
          created_at: "2026-09-25T12:04:00.000Z",
        };
        f.replace([...raw, missed]);
        yield* TestClock.adjust("30 seconds");
        yield* until(() => f.alerts.includes("raise:imsg-watch"));
        expect(f.alerts).toContain("raise:imsg-watch");
        expect(f.alertDetails).toContain("imsg watch stalled or disconnected");
        yield* TestClock.adjust("1 second");
        yield* until(
          () =>
            f.connections.length === 2 &&
            f.commands.filter((command) => command.method === "watch.subscribe").length === 2,
        );
        yield* until(() => seen.some((row) => row.guid === "missed-row"));
        const next = { ...missed, id: 12, guid: "after-stall" };
        f.connections[1]!.notify("message", { subscription: 1, message: next });
        yield* until(() => seen.length === 2);
        expect(f.alerts).toContain("clear:imsg-watch");
        stop();
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("replacement compares the bookmarked row and replays only rows at or after its date", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { seen, stop } = yield* followReady(f, 10);
        const previous = raw[4]!.created_at;
        f.replace([
          { ...raw[3]!, id: 1, created_at: "2026-09-25T12:00:00.000Z", guid: "older" },
          { ...raw[3]!, id: 2, created_at: previous, guid: "same-date" },
          { ...raw[3]!, id: 10, created_at: "2026-09-25T12:04:00.000Z", guid: "same-id-new-date" },
        ]);
        yield* recoverReplacement(f, seen, "same-id-new-date");
        expect(seen.map((row) => row.guid)).toEqual(["same-date", "same-id-new-date"]);
        stop();
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("a replaced database with a shorter tail is caught without watch notifications", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { seen, stop } = yield* followReady(f, 10);
        f.replace([
          {
            ...raw[3]!,
            id: 1,
            guid: "reset-with-short-tail",
            created_at: "2026-09-25T12:04:00.000Z",
          },
        ]);
        yield* recoverReplacement(f, seen, "reset-with-short-tail");
        expect(seen.map((row) => row.guid)).toEqual(["reset-with-short-tail"]);
        stop();
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("a bookmark past the current tail does not replay earlier rows on initial follow", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { seen, stop } = yield* followReady(f, 100);
        expect(seen).toEqual([]);
        stop();
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("the fake process emits a live inbound row on the subscribed stream", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        const seen: IncomingMessage[] = [];
        const stop = yield* follow(messages, 10, seen);
        yield* until(() => f.commands.some((entry) => entry.method === "watch.subscribe"));
        const row = yield* f.inbound(handle, "live", Date.parse(at));
        yield* until(() => seen.length === 1);
        expect(row).toMatchObject({ guid: "incoming-5", fromMe: false, text: "live" });
        expect(seen[0]).toMatchObject({ guid: row.guid, fromMe: false, text: "live" });
        stop();
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("concurrent RPC reads correlate responses; child exit rejects in-flight work and reconnects", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        f.hang("message.send_status");
        const first = yield* Effect.forkChild(messages.status("first").pipe(Effect.result));
        const second = yield* Effect.forkChild(messages.status("second").pipe(Effect.result));
        yield* until(
          () =>
            f.commands.filter((command) => command.method === "message.send_status").length === 2,
        );
        const pending = f.commands.filter((command) => command.method === "message.send_status");
        f.connections[0]!.respond({
          id: pending[1]!.id,
          result: { send_state: "sent", status_fields: null },
        });
        expect(yield* Fiber.join(second)).toMatchObject({ success: { state: "sent" } });
        f.connections[0]!.respond({ id: 999, result: {} });
        yield* Effect.yieldNow;
        f.connections[0]!.close();
        expect(f.connections[0]!.running()).toBe(false);
        const outcome = yield* Fiber.join(first);
        expect(Result.isFailure(outcome) && outcome.failure.message).toBe("imsg RPC exited");
        f.hang("");
        expect((yield* messages.after(0)).length).toBe(raw.length);
        expect(f.connections).toHaveLength(2);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});

test("an exited watch reconnects; empty history subscribes from the beginning", async () => {
  const f = fixture();
  f.replace([]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        const stop = yield* messages.follow(0, () => Effect.void);
        yield* until(() => f.commands.some((entry) => entry.method === "watch.subscribe"));
        expect(
          f.commands.find((entry) => entry.method === "watch.subscribe")?.params["since_rowid"],
        ).toBe(-1);
        yield* TestClock.adjust("30 seconds");
        expect(f.alerts).not.toContain("raise:imsg-watch");
        expect(
          f.commands.some(
            (entry) =>
              entry.method === "messages.after" &&
              entry.params["limit"] === 2 &&
              entry.params["since_rowid"] === 0,
          ),
        ).toBe(true);
        yield* TestClock.adjust("1 second");
        expect(f.alerts).not.toContain("raise:imsg-watch");
        f.connections[0]!.notify("other", { subscription: 1 });
        yield* Effect.yieldNow;
        f.connections[0]!.notify("watch.disconnected", {});
        yield* restartAfterAlert(f);
        stop();
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("malformed imsg watch rows alert and reconnect instead of stopping the follower", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { stop } = yield* followReady(f, 10);
        f.connections[0]!.notify("message", { subscription: 1, message: {} });
        yield* restartAfterAlert(f);
        expect(f.alertDetails).toContain("imsg watch stalled or disconnected");
        stop();
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("missing chats, pending/failed statuses, repeated overflow and non-advancing pages are safe", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        expect(yield* messages.recent("no-chat", 0)).toEqual([]);
        expect((yield* messages.recent(handle, 0)).every((row) => row.handle === handle)).toBe(
          true,
        );
        f.status(raw[0]!.guid, "pending", 0);
        expect(yield* messages.textStatus(handle, 0)).toBe("unknown");
        f.status(raw[0]!.guid, "failed", 5);
        expect(yield* messages.textStatus(handle, 0)).toBe("unknown");
        f.status(raw[0]!.guid, "sent", 0);
        expect(yield* messages.textStatus(handle, 0)).toBe("sent");
        expect(yield* messages.textStatus(handle, Date.parse(raw[0]!.created_at))).toBe("sent");
        expect(yield* messages.textStatus(handle, Date.parse(raw[0]!.created_at) + 1)).toBe(
          "unknown",
        );
        f.status(raw[0]!.guid, "pending", 0);
        expect((yield* messages.status(raw[0]!.guid)).dateRead).toBeNull();
        f.status(raw[0]!.guid, "failed", 22, "2026-09-25T12:00:08.000Z");
        expect(yield* messages.status(raw[0]!.guid)).toEqual({
          state: "failed",
          error: 22,
          dateRead: Date.parse("2026-09-25T12:00:08.000Z"),
        });
        const stop = yield* messages.follow(10, () => Effect.void);
        yield* until(() => f.commands.some((entry) => entry.method === "watch.subscribe"));
        for (let i = 1; i <= 3; i++) {
          f.connections[i - 1]!.notify("watch.overflow", { subscription: 1 });
          yield* TestClock.adjust("1 second");
          yield* until(() => f.connections.length === i + 1);
          yield* until(
            () => f.commands.filter((entry) => entry.method === "watch.subscribe").length === i + 1,
          );
          expect(f.alerts.filter((alert) => alert === "raise:imsg-watch")).toHaveLength(
            i === 3 ? 1 : 0,
          );
        }
        expect(f.alerts).toContain("raise:imsg-watch");
        expect(f.alertDetails).toContain("imsg watch keeps restarting");
        stop();
      }).pipe(Effect.provide(f.dependencies), Effect.provide(TestClock.layer())),
    ),
  );
});

test("replayed probe: forced send, error 22, uncertain send, edits, read date and process reuse", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        expect((yield* messages.after(0)).map((row) => row.id)).toEqual([2, 3, 6, 9, 10]);
        expect(
          f.commands
            .filter((entry) => entry.method === "messages.after")
            .map((entry) => entry.params["since_rowid"]),
        ).toEqual([0, 3, 9]);
        expect(yield* messages.textStatus("<android>", 0)).toBe("no_imessage");
        expect(yield* messages.status(raw[0]!.guid)).toEqual({
          state: "delivered",
          error: 0,
          dateRead: Date.parse("2026-09-25T12:00:08.000Z"),
        });
        f.edit();
        expect((yield* messages.recent(handle, Date.parse(at))).map((row) => row.text)).toEqual([
          "1 텍스트",
          "4 수정 후",
          "",
        ]);
        f.noGUID();
        expect(yield* messages.sendText(handle, "notice")).toEqual({ guid: null });
        f.fail();
        expect((yield* messages.after(0)).length).toBe(raw.length);
        for (let i = 0; i < 3; i++) {
          expect((yield* messages.sendText(handle, "notice").pipe(Effect.flip)).message).toContain(
            "uncertain",
          );
          expect(f.alerts.filter((alert) => alert === "raise:imsg-sends")).toHaveLength(
            i === 2 ? 1 : 0,
          );
        }
        expect(f.alerts).toContain("raise:imsg-sends");
        expect(f.alertDetails).toContain("Repeated imsg send failures");
        f.succeed();
        yield* messages.sendText(handle, "recovered");
        expect(f.alerts).toContain("clear:imsg-sends");
        expect(f.connections).toHaveLength(1);
        expect(
          f.commands
            .filter((entry) => entry.method === "send")
            .every(
              (entry) =>
                entry.params["service"] === "imessage" &&
                entry.params["allow_sms_fallback"] === false,
            ),
        ).toBe(true);
        expect(
          f.commands.some(
            (entry) =>
              entry.method === "messages.history" &&
              entry.params["chat_id"] === 1 &&
              !("offset" in entry.params),
          ),
        ).toBe(true);
        expect(
          f.commands.find((entry) => entry.method === "messages.history")?.params["attachments"],
        ).toBe(true);
        expect(f.alerts).toContain("clear:imsg-sends");
        expect(
          f.commands
            .filter((entry) => entry.method === "messages.after")
            .every(
              (entry) =>
                entry.params["attachments"] === true && entry.params["include_reactions"] === true,
            ),
        ).toBe(true);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});
