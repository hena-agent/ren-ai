import { join } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { IncomingMessage } from "../messages/messages.ts";

export type Attachment = NonNullable<IncomingMessage["attachments"]>[number];

export const imageMime = (attachment: Attachment) => {
  const mime = attachment.mimeType?.toLowerCase();
  const uti = attachment.uti?.toLowerCase();
  if (
    mime === "image/heic" ||
    mime === "image/heif" ||
    uti === "public.heic" ||
    uti === "public.heif"
  ) {
    return "image/heic";
  }
  if (mime === "image/jpeg" || uti === "public.jpeg") return "image/jpeg";
  if (mime === "image/png" || uti === "public.png") return "image/png";
  if (mime === "image/gif" || uti === "com.compuserve.gif") return "image/gif";
  if (mime === "image/webp" || uti === "org.webmproject.webp") return "image/webp";
  return null;
};

/** Read image bytes without leaking the local Messages path to the model. */
export const imageData = (attachment: Attachment) =>
  Effect.gen(function* () {
    const files = Option.getOrUndefined(yield* Effect.serviceOption(FileSystem.FileSystem));
    if (!files) return yield* Effect.fail(new Error("FileSystem unavailable for image"));
    if (imageMime(attachment) !== "image/heic") {
      const bytes = yield* files.readFile(attachment.path);
      return {
        uri: `data:${imageMime(attachment)};base64,${Buffer.from(bytes).toString("base64")}`,
      };
    }
    const process = Option.getOrUndefined(
      yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner),
    );
    if (!process) return yield* Effect.fail(new Error("ChildProcessSpawner unavailable for HEIC"));
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* files.makeTempDirectoryScoped();
        const output = join(directory, "photo.jpeg");
        yield* process.string(
          ChildProcess.make("/usr/bin/sips", [
            "-s",
            "format",
            "jpeg",
            "-Z",
            "1600",
            attachment.path,
            "--out",
            output,
          ]),
        );
        const bytes = yield* files.readFile(output);
        return { uri: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` };
      }),
    );
  }).pipe(Effect.mapError((error) => new Error(`Cannot open image: ${String(error)}`)));
