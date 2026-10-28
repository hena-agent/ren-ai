import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import { PromptInput } from "@opencode/schema/prompt-input";
import { remoteHost } from "../src/opencode/remote.ts";

export default {
  async fetch(request: Request) {
    const data = await request.text();
    const sessionID = Session.ID.make("ses_photo_regression");
    const id = SessionMessage.ID.make("msg_photo_regression");
    const text = "An incoming photo";
    const uri = `data:image/jpeg;base64,${data}`;
    const file = { data, mime: "image/jpeg", source: { type: "inline" } };
    const time = { created: 1 };
    let forwarded = false;
    const upstream: typeof fetch = async (input, init) => {
      const incoming = new Request(input, init);
      if (incoming.method === "POST") {
        const prompt = Schema.decodeUnknownSync(PromptInput.Prompt)(await incoming.json());
        forwarded = prompt.text === text && prompt.files?.[0]?.uri === uri;
        return Response.json({
          data: {
            id,
            sessionID,
            time,
            type: "user",
            delivery: "queue",
            payload: { text, files: [file] },
          },
        });
      }
      return Response.json({
        data: [{ id, time, type: "user", text, files: [file] }],
        cursor: { next: null, previous: null },
      });
    };
    return Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* remoteHost(
          {
            baseUrl: "https://native.example",
            authorization: "Basic test",
            directory: "/personas",
            model: "test/model",
            groundRules: "rules",
          },
          new Map(),
        );
        yield* host.sessions.prompt({ sessionID, id, text, files: [{ uri }] });
        const messages = yield* host.sessions.messages({ sessionID });
        const message = messages[0];
        return Response.json({
          forwarded,
          acknowledged: true,
          historyPreserved: message?.type === "user" && message.files?.[0]?.data === data,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, upstream),
      ),
    );
  },
};
