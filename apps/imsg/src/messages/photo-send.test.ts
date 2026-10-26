import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import type { Messages } from "./messages.ts";
import {
  bridgeFixture,
  cleanup,
  incoming,
  rustpushFixture,
} from "../../test/bridge.test-helper.ts";

afterEach(cleanup);
const handle = "+15550100";
const photo = Buffer.from([255, 216, 255, 224, 1, 255, 217]).toString("base64");
const attempt = "5d4c3b2a-0000-4000-8000-000000000001";
const submit = (messages: Messages) =>
  messages.sendPhoto(handle, photo, attempt).pipe(Effect.andThen(messages.resolveSend(attempt)));

test("identified photos retain private bytes and history across restart without resending", async () => {
  const f = rustpushFixture();
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      const result = yield* messages.sendPhoto(handle, photo, attempt);
      expect(result.guid).toBe(attempt.toUpperCase());
      expect(yield* messages.resolveSend(attempt)).toBe("sent");
      const [row] = yield* messages.recent(handle, 0);
      expect(row?.text).toBe("");
      const attachment = row?.attachments?.[0];
      expect(attachment).toMatchObject({
        mimeType: "image/jpeg",
        uti: "public.jpeg",
        missing: false,
      });
      expect(readFileSync(attachment!.path).toString("base64")).toBe(photo);
      expect(statSync(attachment!.path).mode & 0o777).toBe(0o600);
      yield* messages.sendPhoto(handle, photo, attempt);
      yield* messages.sendPhoto(handle, photo, attempt);
    }),
  );
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      expect(yield* submit(messages)).toBe("sent");
      expect(yield* messages.recent(handle, 0)).toHaveLength(1);
      expect(
        (yield* messages.sendText(handle, "", attempt).pipe(Effect.flip)).cause,
      ).toBeInstanceOf(Error);
    }),
  );
  expect(f.bridge.requests.filter((r) => r.method === "send_image")).toHaveLength(1);
});

test("uncertain photo attempts stay fenced across restart and reconcile a later delivery", async () => {
  const bridge = bridgeFixture();
  const f = rustpushFixture(bridge);
  bridge.answer("send_image", "hang");
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      expect(yield* submit(messages)).toBe("unknown");
      // A settle timeout does not guarantee dispatch; keep the adapter alive until it happens.
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          expect(bridge.requests.filter((r) => r.method === "send_image")).toMatchObject([
            { params: { guid: attempt.toUpperCase(), to: `tel:${handle}` } },
          ]),
        ),
      );
      expect(yield* messages.resolveSend(attempt)).toBe("unknown");
    }),
  );
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      expect(yield* messages.resolveSend(attempt)).toBe("unknown");
      expect(yield* submit(messages)).toBe("unknown");
      const receipt = bridge.deliver({
        ...incoming(`tel:${handle}`, "", 100),
        kind: "delivered",
        guid: attempt.toUpperCase(),
      });
      yield* Effect.promise(() => vi.waitFor(() => expect(bridge.acknowledged).toContain(receipt)));
      expect(yield* messages.resolveSend(attempt)).toBe("delivered");
      const changed = Buffer.from([255, 216, 255, 224, 2, 255, 217]).toString("base64");
      for (const call of [
        messages.sendPhoto("other@example.test", photo, attempt),
        messages.sendPhoto(handle, changed, attempt),
      ])
        expect((yield* call.pipe(Effect.flip)).cause).toBeInstanceOf(Error);
      const missing = crypto.randomUUID();
      expect(yield* messages.resolveSend(missing)).toBe("failed");
      yield* messages.sendPhoto(handle, photo, missing);
    }),
  );
  expect(bridge.requests.filter((r) => r.method === "send_image")).toHaveLength(1);
});

test("preparation failures and native rejection never become sent photos", async () => {
  const f = rustpushFixture();
  writeFileSync(join(f.directory, "outgoing-photos"), "blocked");
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      expect(yield* messages.sendPhoto(handle, photo, attempt).pipe(Effect.flip)).toBeInstanceOf(
        Error,
      );
      expect(yield* messages.resolveSend(attempt)).toBe("failed");
      yield* messages.sendPhoto(handle, photo, attempt);
    }),
  );
  expect(f.bridge.requests.filter((r) => r.method === "send_image")).toHaveLength(0);
  const rejected = rustpushFixture();
  rejected.bridge.answer("send_image", { status: "failed", code: "attachment_upload_failed" });
  await rejected.run(({ messages }) =>
    Effect.gen(function* () {
      expect(yield* submit(messages)).toBe("failed");
      yield* messages.sendPhoto(handle, photo, attempt);
    }),
  );
  expect(rejected.bridge.requests.filter((r) => r.method === "send_image")).toHaveLength(1);
});

test("invalid or oversized JPEG inputs are rejected before admission", async () => {
  const f = rustpushFixture();
  await f.run(({ messages }) =>
    Effect.gen(function* () {
      for (const invalid of [
        "",
        `${photo}\n`,
        "a".repeat(13_333_337),
        Buffer.alloc(10_000_001).toString("base64"),
        ...[0, 1, 2, 5, 6].map((index) => {
          const bytes = Buffer.from(photo, "base64");
          bytes[index] = 0;
          return bytes.toString("base64");
        }),
      ])
        expect(
          yield* messages.sendPhoto(handle, invalid, crypto.randomUUID()).pipe(Effect.flip),
        ).toBeInstanceOf(Error);
      expect(yield* messages.after(0)).toEqual([]);
    }),
  );
  expect(f.bridge.requests.filter((r) => r.method === "send_image")).toHaveLength(0);
});
