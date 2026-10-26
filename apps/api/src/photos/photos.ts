import { Buffer } from "node:buffer";
import { Cause, Clock, Effect, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { codexImage, codexImageModel, ImageGenerationError } from "@ren-ai/image-generation";
import { validatePortrait, type Persona, type Portrait } from "@ren-ai/personas";
import type { PhotoResult, TakePhotoInput } from "@ren-ai/plugin-application";
import type { Conversation } from "../conversations/conversations.ts";
import { contactCause, contactLog, type ContactDiagnostic } from "../discovery/diagnostics.ts";
import { photoPrompt } from "./prompt.ts";
import { jpeg, photoData, photoKey, type PhotoBucket } from "./storage.ts";
import { generationTimeout, photoStore } from "./store.ts";

export interface PhotoOptions {
  personas: ReadonlyMap<string, Persona>;
  sheet: (personaID: string, style: "anime" | "photo") => Promise<Portrait | undefined>;
  bucket: PhotoBucket;
  key: string;
  active: (conversation: Conversation) => Effect.Effect<boolean, Error>;
  fetcher?: typeof fetch;
  log?: (event: ContactDiagnostic & { style: "anime" | "photo" }) => void;
}
const declined: PhotoResult = { status: "declined" };

export const conversationPhotos = (options: PhotoOptions) =>
  Effect.gen(function* () {
    const store = yield* photoStore(options.bucket);
    const log = options.log ?? contactLog;
    const previousResult = (
      conversation: Conversation,
      prior: { id: string; state: string; expires_at: number | null },
      now: number,
    ) =>
      Effect.gen(function* () {
        if (prior.state !== "taken" || prior.expires_at! <= now) return declined;
        const data = yield* photoData(options.bucket, prior.id);
        if (
          !(yield* options.active(conversation)) ||
          prior.expires_at! <= (yield* Clock.currentTimeMillis)
        )
          return declined;
        return data
          ? { status: "taken" as const, photo: prior.id, expiresAt: prior.expires_at!, data }
          : declined;
      });
    const take = (
      conversation: Conversation,
      input: TakePhotoInput,
      callID: string,
    ): Effect.Effect<PhotoResult, Error> =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
        const requestId =
          Option.getOrUndefined(request)?.headers["x-operation-id"] ?? crypto.randomUUID();
        let stage = "admission";
        let style: "anime" | "photo" = "anime";
        const id = crypto.randomUUID();
        let reserved = false;
        const operation = Effect.gen(function* () {
          if (!(yield* options.active(conversation))) return declined;
          const [prior] = yield* store.receipt(conversation, callID);
          if (prior) return yield* previousResult(conversation, prior, started);
          reserved = yield* store.reserve(conversation, callID, id, input.includesMe);
          if (!reserved) return declined;
          const persona = options.personas.get(conversation.personaID);
          const selected = yield* store.style(conversation);
          if (!persona || !selected) return declined;
          style = selected;
          stage = "sheet";
          const sheet = yield* Effect.tryPromise(() =>
            options.sheet(conversation.personaID, style),
          );
          if (!sheet) return declined;
          yield* Effect.try(() => validatePortrait(sheet));
          const references: Portrait[] = input.includesMe ? [sheet] : [];
          if (input.includesMe) {
            stage = "continuity";
            const previous = yield* store.continuity(conversation);
            if (previous)
              references.push({ bytes: Buffer.from(previous, "base64"), mimeType: "image/jpeg" });
          }
          if (!(yield* options.active(conversation)) || !(yield* store.enabled())) return declined;
          stage = "generation";
          const image = yield* Effect.tryPromise((signal) =>
            codexImage({
              key: options.key,
              prompt: photoPrompt(persona.prompt, style, input),
              references,
              size: input.orientation === "portrait" ? "1152x1536" : "1536x1152",
              outputFormat: "jpeg",
              fetcher: options.fetcher ?? fetch,
              signal,
            }),
          );
          const data = yield* Effect.try(() => jpeg(image.bytes));
          stage = "storage";
          // Once a put starts, settle publication before releasing interruption. Its durable queue
          // entry already exists, including when a removal deletes the Conversation during the put.
          return yield* Effect.gen(function* () {
            if (!(yield* options.active(conversation))) return declined;
            yield* Effect.tryPromise(() => options.bucket.put(photoKey(id), image.bytes));
            const expiresAt = yield* store.finish(conversation, id);
            return expiresAt === undefined
              ? declined
              : { status: "taken" as const, photo: id, expiresAt, data };
          }).pipe(Effect.uninterruptible);
        }).pipe(Effect.timeout(generationTimeout));
        return yield* operation.pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              log({
                requestId,
                operation: "photo.take",
                stage,
                outcome: "failed",
                durationMs: now - started,
                level: "error",
                personaId: conversation.personaID,
                model: codexImageModel,
                style,
                code: "interrupted",
                causeName: "InterruptedException",
              });
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const failure = Cause.squash(cause);
              const error =
                failure instanceof Error && failure.cause instanceof ImageGenerationError
                  ? failure.cause
                  : failure;
              const now = yield* Clock.currentTimeMillis;
              log({
                requestId,
                operation: "photo.take",
                stage,
                outcome: "failed",
                durationMs: now - started,
                level: "error",
                personaId: conversation.personaID,
                model: codexImageModel,
                style,
                ...contactCause(error),
                ...(error instanceof ImageGenerationError && {
                  upstreamStatus: error.fields.status,
                  ...(error.fields.causeName &&
                    /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(error.fields.causeName) && {
                      causeName: error.fields.causeName,
                    }),
                  ...(error.fields.causeCode &&
                    /^[A-Z0-9_-]{1,80}$/.test(error.fields.causeCode) && {
                      causeCode: error.fields.causeCode,
                    }),
                  code:
                    error.fields.code && /^[a-z0-9_-]{1,80}$/.test(error.fields.code)
                      ? error.fields.code
                      : "provider_error",
                }),
              });
              return declined;
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              if (reserved) yield* store.decline(id);
            }).pipe(Effect.orDie),
          ),
          Effect.tap((result) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              log({
                requestId,
                operation: "photo.take",
                stage: "complete",
                outcome: "completed",
                durationMs: now - started,
                level: "info",
                personaId: conversation.personaID,
                model: codexImageModel,
                style,
                code: result.status,
              });
            }),
          ),
        );
      });
    return {
      enabled: store.enabled,
      setEnabled: store.setEnabled,
      cleanup: store.cleanup,
      nextCleanup: store.nextCleanup,
      remove: store.remove,
      take,
      sendable: (conversation: Conversation, id: string) =>
        Effect.gen(function* () {
          if (!(yield* options.active(conversation))) return undefined;
          const data = yield* store.sendable(conversation, id);
          return (yield* options.active(conversation)) ? data : undefined;
        }),
    };
  });

export type ConversationPhotos = Effect.Success<ReturnType<typeof conversationPhotos>>;
