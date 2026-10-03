import { SqliteClient } from "@effect/sql-sqlite-node";
import { OnboardingAnswer, PublicPersonas } from "@ren-ai/onboarding";
import type { Persona } from "@ren-ai/personas";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { migrate } from "../database.ts";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import { outbox } from "../outbox/outbox.ts";
import { onboarding, noticeCopy } from "./onboarding.ts";
import type { PersonaRuntime } from "../opencode/runtime.ts";

export const profile = {
  id: "Persona1",
  name: "수아",
  bio: "24살 대학생",
  imageUrl: "",
  published: true,
  timeZone: "Asia/Seoul",
  language: "ko",
  openingLine: "수아의 인사",
  memory: "Remember",
  prompt: "Private prompt",
};

export const catalog = () =>
  new Map([
    [profile.id, profile],
    ["harin", { ...profile, id: "harin", name: "하린", openingLine: "하린의 인사" }],
    ["draft", { ...profile, id: "draft", published: false }],
  ]);

export const catalogAPI = (
  personas: Map<string, Persona>,
  defaultPersonaID = "Persona1",
  runtime?: Pick<PersonaRuntime, "createSession"> & {
    prompt: (sessionID: string, text: string) => Effect.Effect<void, Error>;
  },
) =>
  Effect.gen(function* () {
    yield* migrate;
    const fake = fakeMessages();
    const sends = yield* outbox(fake.messages, fakeGestures().gestures, personas);
    const sessions: string[] = [];
    const prompts: string[] = [];
    const api = yield* onboarding({
      messages: fake.messages,
      notice: noticeCopy,
      personas,
      defaultPersonaID,
      createSession: (id) =>
        runtime
          ? runtime.createSession(id)
          : Effect.sync(() => {
              sessions.push(id);
              return { id: `session-${sessions.length}` };
            }),
      prompt:
        runtime?.prompt ??
        ((_, text) =>
          Effect.sync(() => {
            prompts.push(text);
          })),
      sendNotice: sends.notice,
      turnstileSecret: "secret",
      noticeVersion: "v1",
      deadlineMillis: runtime ? 2000 : 400,
    });
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
    );
    const web = HttpRouter.toWebHandler(
      api.routes.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
    );
    const context = Context.make(HttpClient.HttpClient, http);
    yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
    const list = () =>
      Effect.promise(async () =>
        Schema.decodeUnknownSync(PublicPersonas)(
          await (
            await web.handler(new Request("https://api-msg.hena.dev/personas"), context)
          ).json(),
        ),
      );
    const submit = (handle: string, personaID?: string) =>
      Effect.promise(async () => {
        const response = await web.handler(
          new Request("https://api-msg.hena.dev/onboarding", {
            method: "POST",
            headers: { "content-type": "application/json", "cf-connecting-ip": handle },
            body: JSON.stringify({
              handle,
              locale: "ko",
              privacyNoticeVersion: "v1",
              turnstileToken: "human",
              ...(personaID === undefined ? {} : { personaID }),
            }),
          }),
          context,
        );
        return Schema.decodeUnknownSync(OnboardingAnswer)(await response.json());
      });
    return { api, fake, sessions, prompts, list, submit };
  });

export const catalogDatabase = SqliteClient.layer({ filename: ":memory:" });
