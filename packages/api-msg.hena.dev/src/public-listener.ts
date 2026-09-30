import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/** Preserve streaming and cancellation across the public HTTP boundary. */
export const servePublic = (
  handler: (request: Request) => Promise<Response>,
  port: number,
  hostname = "127.0.0.1",
) =>
  Effect.gen(function* () {
    const node = createServer();
    const server = yield* NodeHttpServer.make(() => node, { port, host: hostname });
    yield* server.serve(
      Effect.gen(function* () {
        const incoming = yield* HttpServerRequest.HttpServerRequest;
        const request = yield* HttpServerRequest.toWeb(incoming);
        const response = yield* Effect.tryPromise((signal) =>
          handler(new Request(request, { signal })),
        ).pipe(Effect.interruptible);
        return HttpServerResponse.fromWeb(response);
      }),
    );
    return node;
  });
