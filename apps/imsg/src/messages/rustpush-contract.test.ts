import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { fakeMessages } from "./messages.fake.ts";
import type { IncomingMessage, Messages } from "./messages.ts";
import { cleanup, incoming, rustpushFixture } from "../../test/bridge.test-helper.ts";

const handle = "+821012345678";
const at = Date.parse("2026-10-16T12:00:00.000Z");
const target = "5D4C3B2A-0000-4000-8000-000000000001";
type Extra = Pick<IncomingMessage, "attachments" | "tapback" | "replyToGuid" | "payload">;
type Text = (
  handle: string,
  content: string,
  date: number,
  extra?: Extra,
) => Effect.Effect<IncomingMessage, Error>;

afterEach(cleanup);

const contract = (
  name: string,
  run: (
    scenario: (
      messages: Messages,
      text: Text,
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
        const seen: IncomingMessage[] = [];
        const stop = yield* messages.follow(0, (row) => Effect.sync(() => void seen.push(row)));
        const row = yield* text(handle, "hello", at);
        expect((yield* messages.after(0)).some((item) => item.guid === row.guid)).toBe(true);
        expect(
          (yield* messages.recent(handle, 0)).some((item) => item.guid === guid && item.fromMe),
        ).toBe(true);
        expect((yield* messages.recent(handle, at)).some((item) => item.guid === row.guid)).toBe(
          true,
        );
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(seen.some((item) => item.guid === row.guid)).toBe(true)),
        );
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
          Effect.sync(() => void seen.push(row)),
        );
        const events: Extra[] = [
          {
            attachments: [
              {
                path: "/state/photo.heic",
                mimeType: "image/heic",
                uti: "public.heic",
                missing: false,
              },
            ],
          },
          { tapback: { emoji: "😂", targetGuid: target, added: true } },
          { tapback: { emoji: "😂", targetGuid: target, added: false } },
          { replyToGuid: target },
          { payload: "location" },
          { payload: "app" },
        ];
        const rows: IncomingMessage[] = [];
        for (const [index, extra] of events.entries())
          rows.push(yield* text(handle, "", at + index * 1000, extra));
        yield* Effect.promise(() => vi.waitFor(() => expect(seen).toHaveLength(rows.length)));
        expect(seen.map((row) => row.guid)).toEqual(rows.map((row) => row.guid));
        for (const [index, row] of rows.entries()) {
          const expected = events[index]!;
          expect(
            (yield* messages.after(previous)).find((item) => item.guid === row.guid),
          ).toMatchObject(expected);
          expect(
            (yield* messages.recent(handle, at)).find((item) => item.guid === row.guid),
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
      f
        .settle(guid, "delivered")
        .pipe(
          Effect.andThen(
            Effect.sync(() => void f.status(handle, { delivered: true, readAt: null })),
          ),
        ),
    ),
  );
});

contract("rustpush", (scenario) => {
  const f = rustpushFixture();
  const them = `tel:${handle}`;
  return f.run(({ messages }) => {
    const text: Text = (_handle, content, date, extra = {}) =>
      Effect.gen(function* () {
        const event = extra.tapback
          ? {
              ...incoming(them, "", date),
              kind: "tapback" as const,
              target: extra.tapback.targetGuid,
              emoji: extra.tapback.emoji,
              added: extra.tapback.added,
            }
          : incoming(them, content, date, {
              attachments: (extra.attachments ?? []).map((item) => ({
                path: item.path,
                mime: item.mimeType ?? "",
                uti: item.uti ?? "",
              })),
              replyTo: extra.replyToGuid ?? null,
              payload: extra.payload ?? null,
            });
        f.bridge.deliver(event);
        return yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const row = (await Effect.runPromise(messages.after(0))).find(
              (item) => item.guid === event.guid,
            );
            expect(row).toBeDefined();
            return row!;
          }),
        );
      });
    const settle = (guid: string) =>
      Effect.promise(async () => {
        f.bridge.deliver({ ...incoming(them, "", at), kind: "delivered", guid });
        await vi.waitFor(async () =>
          expect((await Effect.runPromise(messages.status(guid))).state).toBe("delivered"),
        );
      });
    return scenario(messages, text, settle);
  });
});
