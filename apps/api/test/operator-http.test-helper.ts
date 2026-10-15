import { Effect } from "effect";
import { servePublic } from "@ren-ai/transport/listener";
import { listenerUrl } from "./listener.test-helper.ts";

export const authenticatedOperator =
  (handler: (request: Request) => Promise<Response>, token: string) => async (request: Request) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("Unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/operator/")) return new Response(null, { status: 404 });
    url.pathname = url.pathname.slice("/operator".length);
    return handler(new Request(url, request));
  };

export const serveTestOperator = (handler: (request: Request) => Promise<Response>) =>
  Effect.gen(function* () {
    const token = "operator-test-token";
    const listener = yield* servePublic(authenticatedOperator(handler, token), 0);
    return { url: listenerUrl(listener), token };
  });
