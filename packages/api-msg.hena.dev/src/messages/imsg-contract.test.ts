import { Effect } from "effect";
import { expect, test } from "vitest";
import { makeImsgMessages } from "./imsg.ts";
import { at, fixture, handle, raw } from "./imsg.fake.ts";
import { fakeMessages } from "./messages.fake.ts";
import type { IncomingMessage, Messages } from "./messages.ts";

const contract = (
  name: string,
  run: (
    scenario: (
      messages: Messages,
      text: (
        handle: string,
        content: string,
        date: number,
        extra?: Pick<IncomingMessage, "attachments" | "tapback" | "replyToGuid" | "payload">,
      ) => Effect.Effect<IncomingMessage, Error>,
      settle: (guid: string) => Effect.Effect<void, Error>,
    ) => Effect.Effect<void, Error>,
  ) => Promise<void>,
) => {
  test(`${name}: send, follow, after, recent and status share the same contract`, async () => {
    await run((messages, text, settle) =>
      Effect.gen(function* () {
        const guid = (yield* messages.sendText(handle, "hi")).guid;
        expect(guid).toBeTruthy();
        yield* settle(guid!);
        expect((yield* messages.status(guid!)).state).toBe("delivered");
        expect(yield* messages.sendStatus(guid!)).toBe("delivered");
        expect(yield* messages.sendStatus("not-yet-present")).toBe("unknown");
        expect(yield* messages.lastOutgoingStatus(handle)).toEqual({
          delivered: true,
          readAt: null,
        });
        expect(yield* messages.lastOutgoingStatus("absent")).toBeUndefined();
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
          (yield* messages.recent(handle, 0)).some((item) => item.guid === guid && item.fromMe),
        ).toBe(true);
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
  test(`${name}: images, tapbacks, inline replies and placeholders survive after/recent/follow`, async () => {
    await run((messages, text) =>
      Effect.gen(function* () {
        const seen: IncomingMessage[] = [];
        const previous = (yield* messages.after(0)).at(-1)?.id ?? 0;
        const stop = yield* messages.follow(previous, (row) =>
          Effect.sync(() => {
            seen.push(row);
          }),
        );
        const events: Array<
          Pick<IncomingMessage, "attachments" | "tapback" | "replyToGuid" | "payload">
        > = [
          {
            attachments: [
              {
                path: "/Messages/photo.heic",
                mimeType: "image/heic",
                uti: "public.heic",
                missing: false,
              },
            ],
          },
          { tapback: { emoji: "😂", targetGuid: raw[0]!.guid, added: true } },
          { tapback: { emoji: "😂", targetGuid: raw[0]!.guid, added: false } },
          { replyToGuid: raw[0]!.guid },
          { payload: "location" },
          { payload: "app" },
        ];
        const rows: IncomingMessage[] = [];
        for (const [index, extra] of events.entries())
          rows.push(yield* text(handle, "", Date.parse(at) + index * 1000, extra));
        for (let i = 0; i < 100 && seen.length < rows.length; i++) yield* Effect.yieldNow;
        expect(seen.map((row) => row.guid)).toEqual(rows.map((row) => row.guid));
        for (const [index, row] of rows.entries()) {
          const expected = events[index]!;
          expect(
            (yield* messages.after(previous)).find((item) => item.guid === row.guid),
          ).toMatchObject(expected);
          expect(
            (yield* messages.recent(handle, Date.parse(at))).find((item) => item.guid === row.guid),
          ).toMatchObject(expected);
          expect(seen[index]).toMatchObject(expected);
        }
        stop();
      }),
    );
  });
};

contract("memory", (scenario) => {
  const f = fakeMessages();
  return Effect.runPromise(
    scenario(f.messages, f.text, (guid) =>
      f.settle(guid, "delivered").pipe(
        Effect.andThen(
          Effect.sync(() => {
            f.status(handle, { delivered: true, readAt: null });
          }),
        ),
      ),
    ),
  );
});

contract("imsg replay", (scenario) => {
  const f = fixture();
  f.status("not-yet-present", "pending", 0);
  f.status(raw[0]!.guid, "delivered", 0);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* makeImsgMessages(f.alertsService);
        yield* scenario(messages, f.inbound, () => Effect.void);
      }).pipe(Effect.provide(f.dependencies)),
    ),
  );
});
