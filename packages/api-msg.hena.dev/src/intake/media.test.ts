import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlClient } from "effect/unstable/sql";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, test } from "vitest";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { imageData, imageMime } from "./images.ts";
import { intake, type PromptImage } from "./intake.ts";

const handle = "him@example.com";
const at = Date.parse("2026-09-25T12:00:00Z");
const attachment = (mimeType: string | null, uti: string | null = null, missing = false) => ({
  path: "/private/Messages/photo.heic",
  mimeType,
  uti,
  missing,
});
const capture =
  (prompts: { text: string; images: ReadonlyArray<PromptImage> | undefined }[]) =>
  (_session: string, _id: string, text: string, images?: ReadonlyArray<PromptImage>) =>
    Effect.sync(() => {
      prompts.push({ text, images });
    });

const fixtures = () => {
  const commands: string[][] = [];
  const files = FileSystem.layerNoop({
    readFile: (path) =>
      Effect.succeed(new TextEncoder().encode(path.endsWith("photo.jpeg") ? "jpeg" : "raw")),
    makeTempDirectoryScoped: () => Effect.succeed("/test-temp"),
  });
  const process = ChildProcessSpawner.ChildProcessSpawner.of({
    ...ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
    string: (command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline");
        commands.push([command.command, ...command.args]);
        return "ok";
      }),
  });
  return {
    commands,
    layer: Layer.merge(files, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, process)),
  };
};

test("converts HEIC via sips, and sends only inline data URLs", async () => {
  const fixture = fixtures();
  const result = await Effect.runPromise(
    imageData(attachment("image/heic")).pipe(Effect.provide(fixture.layer)),
  );
  expect(result).toEqual({
    uri: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
  });
  expect(fixture.commands).toEqual([
    [
      "/usr/bin/sips",
      "-s",
      "format",
      "jpeg",
      "-Z",
      "1600",
      "/private/Messages/photo.heic",
      "--out",
      "/test-temp/photo.jpeg",
    ],
  ]);
  expect(
    await Effect.runPromise(imageData(attachment("image/png")).pipe(Effect.provide(fixture.layer))),
  ).toEqual({ uri: `data:image/png;base64,${Buffer.from("raw").toString("base64")}` });
  expect(fixture.commands).toHaveLength(1);
  expect(imageMime(attachment(null, "public.heic"))).toBe("image/heic");
  expect(imageMime(attachment("image/heif"))).toBe("image/heic");
  expect(imageMime(attachment(null, "public.heif"))).toBe("image/heic");
  expect(imageMime(attachment(null, "public.jpeg"))).toBe("image/jpeg");
  expect(imageMime(attachment(null, "public.png"))).toBe("image/png");
  expect(imageMime(attachment(null, "com.compuserve.gif"))).toBe("image/gif");
  expect(imageMime(attachment(null, "org.webmproject.webp"))).toBe("image/webp");
  expect(imageMime(attachment("image/gif"))).toBe("image/gif");
  expect(imageMime(attachment("image/webp"))).toBe("image/webp");
  expect(imageMime(attachment("application/pdf"))).toBeNull();
  const missingFiles = await Effect.runPromise(Effect.flip(imageData(attachment("image/png"))));
  expect(missingFiles.message).toContain("Cannot open image: Error: FileSystem unavailable");
  const missingProcess = await Effect.runPromise(
    Effect.flip(imageData(attachment("image/heic")).pipe(Effect.provide(FileSystem.layerNoop({})))),
  );
  expect(missingProcess.message).toContain(
    "Cannot open image: Error: ChildProcessSpawner unavailable",
  );
});

test("Intake quotes targets, admits media and placeholders, ignores removed tapbacks", async () => {
  const fixture = fixtures();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const fake = fakeMessages();
        yield* directory.create({
          handle,
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "persona1",
          sessionID: "session-media",
        });
        const prompts: { text: string; images: ReadonlyArray<PromptImage> | undefined }[] = [];
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          capture(prompts),
          () => "Asia/Seoul",
        );
        const signals: number[] = [];
        incoming.onNew((conversation) => signals.push(conversation.id));
        const hers = yield* fake.outgoing(handle, '헐 "맛" <photo', at);
        yield* fake.text(handle, "", at + 60_000, {
          tapback: { emoji: "😂", targetGuid: hers.guid, added: true },
        });
        yield* fake.text(handle, "", at + 120_000, {
          tapback: { emoji: "😂", targetGuid: hers.guid, added: false },
        });
        yield* fake.text(handle, '봐 "여기" <tapback', at + 180_000, { replyToGuid: hers.guid });
        const his = yield* fake.text(handle, "hi", at + 240_000);
        yield* fake.text(handle, "", at + 300_000, {
          tapback: { emoji: "❤️", targetGuid: his.guid, added: true },
        });
        yield* fake.text(handle, "caption", at + 360_000, {
          attachments: [attachment("image/heic"), attachment("image/gif")],
        });
        const photos = yield* fake.text(handle, "", at + 420_000, {
          attachments: [
            attachment("image/png"),
            attachment("image/webp"),
            attachment("image/jpeg"),
          ],
        });
        yield* fake.text(handle, "", at + 480_000, {
          attachments: [
            attachment("audio/m4a"),
            attachment("video/mp4"),
            attachment("application/pdf"),
            attachment("image/heic", null, true),
            attachment(null),
          ],
        });
        yield* fake.text(handle, "", at + 540_000, { payload: "location" });
        yield* fake.text(handle, "", at + 600_000, { payload: "app" });
        yield* fake.text(handle, "https://example.com", at + 660_000);
        yield* fake.text(handle, "", at + 720_000);
        expect(prompts.map((item) => item.text)).toEqual([
          '<tapback at="2026-09-25 Fri 21:01" emoji="😂" on="your message: 헐 ”맛” ‹photo"/>',
          '<message at="2026-09-25 Fri 21:03" reply-to="your message: 헐 ”맛” ‹photo">봐 "여기" ‹tapback</message>',
          '<message at="2026-09-25 Fri 21:04">hi</message>',
          '<tapback at="2026-09-25 Fri 21:05" emoji="❤️" on="his message: hi"/>',
          '<message at="2026-09-25 Fri 21:06">caption</message>\n<photo at="2026-09-25 Fri 21:06"/>\n<photo at="2026-09-25 Fri 21:06"/>',
          '<photo at="2026-09-25 Fri 21:07"/>\n<photo at="2026-09-25 Fri 21:07"/>\n<photo at="2026-09-25 Fri 21:07"/>',
          '<voice-memo at="2026-09-25 Fri 21:08"/>\n<video at="2026-09-25 Fri 21:08"/>\n<file at="2026-09-25 Fri 21:08"/>\n<file at="2026-09-25 Fri 21:08"/>\n<file at="2026-09-25 Fri 21:08"/>',
          '<location at="2026-09-25 Fri 21:09"/>',
          '<app at="2026-09-25 Fri 21:10"/>',
          '<message at="2026-09-25 Fri 21:11">https://example.com</message>',
          '<app at="2026-09-25 Fri 21:12"/>',
        ]);
        expect(prompts[4]?.images?.map((file) => file.uri.startsWith("data:"))).toEqual([
          true,
          true,
        ]);
        expect(prompts[5]?.images).toHaveLength(3);
        expect(signals).toHaveLength(prompts.length);
        yield* fake.text(handle, "", at + 780_000, {
          tapback: { emoji: "?", targetGuid: "absent", added: true },
        });
        yield* fake.text(handle, "", at + 840_000, { replyToGuid: "absent" });
        expect(prompts.at(-2)?.text).toContain('on="message unavailable"');
        expect(prompts.at(-1)?.text).toContain('reply-to="message unavailable"');
        yield* fake.text(handle, "", at + 900_000, {
          tapback: { emoji: "👍", targetGuid: photos.guid, added: true },
        });
        expect(prompts.at(-1)?.text).toContain('on="his message: photo"');
        const empty = yield* fake.text(handle, "", at + 960_000);
        yield* fake.text(handle, "", at + 1_020_000, {
          tapback: { emoji: "👍", targetGuid: empty.guid, added: true },
        });
        expect(prompts.at(-1)?.text).toContain('on="his message: message unavailable"');
        yield* fake.text(handle, "", at + 1_080_000, {
          replyToGuid: photos.guid,
          attachments: [attachment("image/jpeg")],
        });
        expect(prompts.at(-1)?.text).toContain(
          '<message at="2026-09-25 Fri 21:18" reply-to="his message: photo"></message>\n<photo at="2026-09-25 Fri 21:18"/>',
        );
        const count = prompts.length;
        yield* fake.redeliver({
          ...photos,
          id: 999,
          guid: "removed-outgoing-tapback",
          fromMe: true,
          tapback: { emoji: "👍", targetGuid: photos.guid, added: false },
        });
        expect(prompts).toHaveLength(count);
        expect(
          (yield* sql<{ rowID: number }>`SELECT row_id AS rowID FROM bookmark`)[0]?.rowID,
        ).toBe(999);
      }).pipe(
        Effect.provide(Layer.merge(fixture.layer, SqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );
});

test("rebuilding replays photos, replies, tapbacks and placeholders like live Intake", () => {
  const fixture = fixtures();
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient.SqlClient;
        const directory = yield* conversations;
        const conversation = yield* directory.create({
          handle,
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID: "persona1",
          sessionID: "session-replay-media",
        });
        const fake = fakeMessages();
        const when = Date.now() + 1_000;
        const original = yield* fake.text(handle, "hello", when);
        yield* fake.text(handle, "caption", when + 60_000, {
          replyToGuid: original.guid,
          attachments: [attachment("image/png"), attachment("audio/m4a")],
        });
        yield* fake.text(handle, "", when + 120_000, {
          tapback: { emoji: "👍", targetGuid: original.guid, added: true },
        });
        const removed = yield* fake.text(handle, "", when + 180_000, {
          tapback: { emoji: "👍", targetGuid: original.guid, added: false },
        });
        yield* fake.text(handle, "", when + 240_000, { payload: "location" });
        const prompts: { text: string; images: ReadonlyArray<PromptImage> | undefined }[] = [];
        const record = capture(prompts);
        const incoming = yield* intake(
          fake.messages,
          directory.byHandle,
          record,
          () => "Asia/Seoul",
          undefined,
          undefined,
          undefined,
          false,
        );
        yield* incoming.replay(conversation);
        expect(prompts).toHaveLength(4);
        expect(prompts[1]?.text).toContain('reply-to="his message: hello"');
        expect(prompts[1]?.text).toContain("<photo at=");
        expect(prompts[1]?.text).toContain("<voice-memo at=");
        expect(prompts[1]?.images).toEqual([
          { uri: `data:image/png;base64,${Buffer.from("raw").toString("base64")}` },
        ]);
        expect(prompts[2]?.text).toContain('emoji="👍" on="his message: hello"');
        expect(prompts[3]?.text).toContain("<location at=");
        expect(yield* sql`SELECT 1 FROM intake_seen WHERE guid = ${removed.guid}`).toEqual([]);
      }).pipe(
        Effect.provide(Layer.merge(fixture.layer, SqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );
});
