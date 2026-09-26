import { chmod, mkdir } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname } from "node:path";
import { buffer } from "node:stream/consumers";
import { Effect } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { operatorApi } from "./api.ts";

/** The state directory protects the socket while it is being created and chmodded. */
export const serveOperatorSocket = async (
  path: string,
  handler: (request: Request) => Promise<Response>,
) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const body = await buffer(incoming);
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          headers.set(key, String(value));
        }
        const request = new Request(`http://operator${incoming.url!}`, {
          method: incoming.method!,
          headers,
          ...(body.length ? { body } : {}),
        });
        const response = await handler(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
};

/** Use the HTTP API's own typed client, transported over the private Unix socket. */
export const operatorClient = (path: string) => {
  const client = HttpClient.make((request) =>
    HttpClientRequest.toWeb(request).pipe(
      Effect.flatMap((web) =>
        Effect.tryPromise(
          () =>
            new Promise<Response>((resolve, reject) => {
              const connection = httpRequest(
                {
                  socketPath: path,
                  path: new URL(web.url).pathname,
                  method: web.method,
                  headers: Object.fromEntries(web.headers),
                },
                (response) => {
                  void buffer(response).then((body) => {
                    const headers = new Headers();
                    for (const [key, value] of Object.entries(response.headers)) {
                      headers.set(key, String(value));
                    }
                    return resolve(
                      new Response(body, {
                        status: response.statusCode!,
                        headers,
                      }),
                    );
                  }, reject);
                },
              );
              connection.on("error", reject);
              void web.arrayBuffer().then((body) => connection.end(Buffer.from(body)), reject);
            }),
        ),
      ),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      ),
    ),
  );
  return HttpApiClient.make(operatorApi, { baseUrl: "http://operator" }).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );
};
