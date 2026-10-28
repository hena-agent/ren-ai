import { Effect } from "effect";
import assert from "node:assert/strict";
import { SqlClient } from "effect/sql";
import { vi } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { conversationPhotos, type PhotoOptions } from "./photos.ts";
import type { TakePhotoInput } from "@ren-ai/plugin-application";
import type { PhotoBucket } from "./storage.ts";
import { registration } from "../../test/messaging.test-helper.ts";

export const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, 2, 0xff, 0xd9]);
export const hour = 3_600_000;
export const input: TakePhotoInput = {
  scene: "private scene",
  includesMe: true,
  orientation: "portrait",
};
export const fixture = Effect.gen(function* () {
  yield* migrate;
  const sql = yield* SqlClient.SqlClient;
  const conv = yield* conversations;
  const conversation = yield* conv.create(registration("private handle", "session"));
  const other = yield* conv.create(registration("other handle", "other"));
  const objects = new Map<string, Uint8Array>();
  const bucket: PhotoBucket = {
    get: vi.fn<PhotoBucket["get"]>(async (key) => {
      const object = objects.get(key);
      return object ? { arrayBuffer: async () => Uint8Array.from(object).buffer } : null;
    }),
    put: vi.fn<PhotoBucket["put"]>(async (key, value) => {
      objects.set(key, value);
      return {};
    }),
    delete: vi.fn<PhotoBucket["delete"]>(async (key) => {
      objects.delete(key);
    }),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () =>
      Response.json({ data: [{ b64_json: Buffer.from(bytes).toString("base64") }] }),
    );
  const log = vi.fn<NonNullable<PhotoOptions["log"]>>();
  const options: PhotoOptions = {
    personas: new Map([
      [
        "persona1",
        {
          id: "persona1",
          prompt: "private description",
          memory: "memory",
          openingLine: "hello",
          language: "ko",
          timeZone: "Asia/Seoul",
        },
      ],
    ]),
    sheet: vi.fn<PhotoOptions["sheet"]>(async () => ({ bytes, mimeType: "image/jpeg" })),
    bucket,
    key: "private key",
    active: conv.active,
    fetcher,
    log,
  };
  const photos = yield* conversationPhotos(options);
  return { sql, conv, conversation, other, objects, bucket, options, photos, fetcher, log };
});

export const takenFixture = (callID: string, state?: "sent" | "not_sent") =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const photo = yield* f.photos.take(f.conversation, input, callID);
    assert(photo.status === "taken", "Expected fixture photo");
    if (state)
      yield* f.sql`INSERT INTO send(handle,conversation_id,kind,content,state,recorded_at,updated_at)
    VALUES(${f.conversation.handle},${f.conversation.id},'photo',${photo.photo},${state},0,0)`;
    return { f, photo };
  });
