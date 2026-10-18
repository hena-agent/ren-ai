import { Effect, Fiber } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import type { IncomingMessage } from "./messages.ts";
import {
  bridgeFixture,
  cleanup,
  incoming,
  rustpushFixture as adapter,
  service,
} from "../../test/bridge.test-helper.ts";

const them = "tel:+821012345678";
const handle = "+821012345678";

afterEach(cleanup);
const sent = (bridge: ReturnType<typeof bridgeFixture>, method: string) =>
  bridge.requests.filter((request) => request.method === method).map((request) => request.params);

test("texts are recorded before submission and settled by Apple's answer", async () => {
  const f = adapter();
  f.bridge.answer(
    "send",
    { status: "sent" },
    { status: "failed", code: "no_imessage" },
    { status: "failed", code: "rejected" },
    { stage: "input", cause: { code: "invalid_recipient" } },
  );
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      const delivered = (yield* messages.sendText(handle, "hello")).guid!;
      expect(sent(f.bridge, "send")[0]).toEqual({
        from: service,
        guid: delivered,
        to: them,
        text: "hello",
      });
      expect(f.bridge.spawned[0]).toMatchObject({ args: ["rpc", service] });
      expect(yield* messages.sendStatus(delivered)).toBe("sent");
      expect(yield* messages.textStatus(handle, 0)).toBe("sent");
      f.bridge.deliver({ ...incoming(them, "", 1), kind: "delivered", guid: delivered });
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toHaveLength(1)));
      expect(yield* messages.status(delivered)).toEqual({
        state: "delivered",
        error: 0,
        dateRead: null,
      });
      expect(yield* messages.lastOutgoingStatus(handle)).toEqual({ delivered: true, readAt: null });
      const unreachable = (yield* messages.sendText(handle, "anyone there?")).guid!;
      expect([
        yield* messages.sendStatus(unreachable),
        yield* messages.textStatus(handle, 0),
      ]).toEqual(["failed", "no_imessage"]);
      const rejected = (yield* messages.sendText(handle, "rejected")).guid!;
      expect([
        (yield* messages.status(rejected)).error,
        yield* messages.textStatus(handle, 0),
      ]).toEqual([1, "unknown"]);
      const invalid = (yield* messages.sendText("someone@example.com", "bad")).guid!;
      expect(sent(f.bridge, "send").at(-1)).toMatchObject({ to: "mailto:someone@example.com" });
      expect(yield* messages.sendStatus(invalid)).toBe("failed");
      expect(yield* messages.lastOutgoingStatus("absent@example.com")).toBeUndefined();
      expect(yield* messages.sendStatus("not-yet-present")).toBe("unknown");
      expect((yield* messages.recent(handle, 0)).map((row) => row.fromMe)).toEqual([
        true,
        true,
        true,
      ]);
    }),
  );
  expect(f.alerts.filter((alert) => alert === "clear:rustpush-sends")).toHaveLength(3);
});

test("an unanswered send stays in doubt, settles later and alerts when doubts repeat", async () => {
  const f = adapter(bridgeFixture(), 20);
  f.bridge.answer(
    "send",
    "hang",
    { stage: "send", cause: { code: "unconfirmed" } },
    "hang",
    "hang",
  );
  await f.run(({ messages, gestures }) =>
    Effect.gen(function* () {
      const slow = (yield* messages.sendText(handle, "slow")).guid!;
      expect(yield* messages.sendStatus(slow)).toBe("unknown");
      const doubted = (yield* messages.sendText(handle, "doubted")).guid!;
      expect(yield* messages.sendStatus(doubted)).toBe("unknown");
      yield* messages.sendText(handle, "third");
      yield* messages.sendText(handle, "fourth");
      f.bridge.exit();
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(f.alerts).toContain("raise:rustpush-sends")),
      );
      expect(yield* messages.sendStatus(slow)).toBe("unknown");
      expect(yield* messages.textStatus(handle, 0)).toBe("unknown");
      yield* Effect.promise(() => vi.waitFor(() => Effect.runPromise(gestures.probe())));
      const recovered = (yield* messages.sendText(handle, "after restart")).guid!;
      expect(yield* messages.sendStatus(recovered)).toBe("sent");
    }),
  );
});

test("a bridge that is not running fails a send definitively", async () => {
  const bridge = bridgeFixture();
  const f = adapter(bridge);
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      bridge.answer("handles", "hang");
      bridge.exit();
      yield* Effect.promise(() => vi.waitFor(() => expect(bridge.spawned).toHaveLength(2)));
      const guid = (yield* messages.sendText(handle, "nobody home")).guid!;
      expect(yield* messages.sendStatus(guid)).toBe("failed");
    }),
  );
});

test("only a send result can settle a text, and even an empty failure code is a failure", async () => {
  const f = adapter();
  f.bridge.answer("send", { acknowledged: true }, { status: "failed", code: "" });
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      const malformed = (yield* messages.sendText(handle, "uncertain")).guid!;
      expect(yield* messages.sendStatus(malformed)).toBe("unknown");
      const failed = (yield* messages.sendText(handle, "rejected")).guid!;
      expect(yield* messages.status(failed)).toEqual({ state: "failed", error: 1, dateRead: null });
    }),
  );
});

test("incoming events become rows that followers receive in order", async () => {
  const f = adapter();
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      const early = f.bridge.deliver(incoming(them, "before follow", 1_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toEqual([early])));
      const seen: IncomingMessage[] = [];
      const stop = yield* messages.follow(0, (row) =>
        row.text === "refused once" && !seen.some((item) => item.text === "refused")
          ? Effect.sync(() => seen.push({ ...row, text: "refused" })).pipe(
              Effect.andThen(Effect.fail(new Error("retry"))),
            )
          : Effect.sync(() => {
              seen.push(row);
            }),
      );
      const live = f.bridge.deliver(incoming(them, "live", 2_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toContain(live)));
      yield* messages.sendText(handle, "reply");
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(seen.map((row) => row.text)).toEqual(["before follow", "live", "reply"]),
        ),
      );
      f.bridge.deliver(incoming(them, "refused once", 3_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(seen.at(-1)?.text).toBe("refused")));
      f.bridge.deliver(incoming(them, "next", 4_000));
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(seen.map((row) => row.text).slice(-2)).toEqual(["refused once", "next"]),
        ),
      );
      stop();
      f.bridge.deliver(incoming(them, "after stop", 5_000));
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toHaveLength(5)));
      expect(seen.some((row) => row.text === "after stop")).toBe(false);
      expect((yield* messages.after(0)).map((row) => row.text)).toContain("after stop");
      const page = yield* messages.after(0, 1);
      expect(page.map((row) => row.text)).toEqual(["before follow"]);
      expect((yield* messages.after(page[0]!.id, 1)).map((row) => row.text)).toEqual(["live"]);
    }),
  );
});

test("gestures act on the person's latest message from the service handle", async () => {
  const f = adapter();
  f.bridge.answer("react", { status: "failed", code: "rejected" });
  await f.run(({ gestures }) =>
    Effect.gen(function* () {
      yield* gestures.read(handle);
      expect(sent(f.bridge, "read")).toEqual([]);
      expect((yield* gestures.react(handle, "like").pipe(Effect.flip)).message).toContain(
        "No message",
      );
      const message = incoming(them, "how are you?", 1_000);
      f.bridge.deliver(message);
      f.bridge.deliver({
        ...incoming(them, "", 1_001),
        kind: "tapback",
        target: "X",
        emoji: "👍",
        added: true,
      });
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toHaveLength(2)));
      yield* gestures.read(handle);
      expect(sent(f.bridge, "read")).toEqual([{ to: them, guid: message.guid }]);
      expect((yield* gestures.react(handle, "love").pipe(Effect.flip)).message).toContain(
        "did not accept",
      );
      yield* gestures.react(handle, "love");
      expect(sent(f.bridge, "react").at(-1)).toEqual({
        to: them,
        guid: message.guid,
        tapback: "love",
        text: "how are you?",
      });
      expect(yield* gestures.typing(handle, "ignored", 30)).toBe(true);
      expect(sent(f.bridge, "typing")).toEqual([{ to: them, active: true }]);
      const typing = yield* Effect.forkChild(gestures.typing(handle, "ignored", 5_000));
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(sent(f.bridge, "typing")).toHaveLength(2)),
      );
      f.bridge.deliver(incoming(them, "wait", 2_000));
      expect(yield* Fiber.join(typing)).toBe(false);
      expect(sent(f.bridge, "typing").at(-1)).toEqual({ to: them, active: false });
      f.bridge.answer("typing", { stage: "send", cause: { code: "unconfirmed" } });
      expect((yield* gestures.typing(handle, "", 10).pipe(Effect.flip)).message).toContain(
        "rejected",
      );
    }),
  );
});

test("the probe requires the service handle to be registered", async () => {
  const bridge = bridgeFixture();
  const f = adapter(bridge);
  await f.run(({ gestures }) =>
    Effect.gen(function* () {
      bridge.answer("handles", { handles: ["mailto:other@renai.im"] }, { acknowledged: true });
      expect((yield* gestures.probe().pipe(Effect.flip)).message).toContain("not registered");
      expect((yield* gestures.probe().pipe(Effect.flip)).message).toContain("not registered");
      bridge.exit();
      bridge.answer("handles", "hang");
      yield* Effect.promise(() => vi.waitFor(() => expect(bridge.spawned).toHaveLength(2)));
      expect((yield* gestures.probe().pipe(Effect.flip)).message).toContain("not running");
    }),
  );
});
