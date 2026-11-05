import { createHash } from "node:crypto";
import { OpenCode } from "@opencode/client/effect";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import type { SocialImageData } from "@ren-ai/onboarding/social-images";
import { sessionFolders, folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import {
  SocialDecision,
  supportsSocialAction,
  type SocialTask,
  type SocialRun,
} from "@ren-ai/onboarding/social";
import { imageFiles, socialPrompt } from "./model-input.ts";

export interface SocialModel {
  readonly model: string;
  decide: (
    task: SocialTask,
    run: SocialRun,
    observation: string,
    signal: AbortSignal,
  ) => Promise<SocialDecision>;
  interrupt: (task: SocialTask, run: SocialRun) => Promise<void>;
}
const socialSessionID = (task: SocialTask, run: SocialRun) =>
  Session.ID.make(
    `ses_social_${createHash("sha256")
      .update(
        JSON.stringify([
          task.account.id,
          task.account.personaId,
          run.generation,
          run.contact?.toLowerCase() ?? null,
        ]),
      )
      .digest("hex")
      .slice(0, 48)}`,
  );
const perform = <T, E>(
  effect: Effect.Effect<T, E, HttpClient.HttpClient>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
    ),
    { signal },
  );

export function socialModel(
  config: {
    url: string;
    authorization: string;
    directory: string;
    model: string;
    image?: (runId: string, imageId: string) => Promise<SocialImageData>;
  },
  fetcher: typeof fetch = fetch,
): SocialModel {
  const client = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* OpenCode.make({ baseUrl: config.url }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        http.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", config.authorization)),
        ),
      ),
    );
  });
  return {
    model: config.model,
    decide: (task, run, observation, signal) =>
      perform(
        Effect.gen(function* () {
          const api = yield* client;
          const sessionID = socialSessionID(task, run);
          const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(folderSnapshot))(
            task.snapshot,
          );
          yield* api.rpc(sessionFolders).create(
            {
              folderID: sessionID,
              model: config.model,
              conversationKey: sessionID,
              snapshot: {
                ...snapshot,
                binding: {
                  personaID: task.account.personaId,
                  conversationKey: sessionID,
                  writable: true,
                  social: { accountID: task.account.id, contact: run.contact },
                },
              },
            },
            { location: { directory: config.directory } },
          );
          const before = yield* api.message.list({
            sessionID,
            type: "assistant",
            order: "desc",
            limit: 1,
          });
          const id = SessionMessage.ID.make(`msg_social_${run.id.replaceAll("-", "")}_${run.step}`);
          const schema = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(SocialDecision))[
            "~standard"
          ].jsonSchema.input({ target: "draft-2020-12" });
          const files = yield* Effect.tryPromise(() => imageFiles(task, run, config.image));
          yield* api.session.prompt({
            sessionID,
            id,
            files,
            text: socialPrompt(task, run, observation, JSON.stringify(schema)),
          });
          yield* api.session.wait({ sessionID });
          const page = yield* api.message.list({
            sessionID,
            type: "assistant",
            order: "desc",
            limit: 20,
          });
          const assistant = page.data.find((message) => message.type === "assistant");
          if (!assistant || assistant.id === before.data[0]?.id || assistant.error)
            throw new Error("Social decision did not complete");
          const text = assistant.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
          try {
            const decision = Schema.decodeUnknownSync(Schema.fromJsonString(SocialDecision), {
              onExcessProperty: "error",
            })(text);
            if (!supportsSocialAction(task.account.platform, decision.action))
              throw new Error("Unsupported platform action");
            return decision;
          } catch {
            throw new Error("Invalid structured social decision");
          }
        }),
        fetcher,
        signal,
      ),
    interrupt: (task, run) =>
      perform(
        client.pipe(
          Effect.flatMap((api) => api.session.interrupt({ sessionID: socialSessionID(task, run) })),
          Effect.asVoid,
        ),
        fetcher,
      ),
  };
}
