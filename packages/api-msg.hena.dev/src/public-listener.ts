import { createServer } from "node:http";
import { once } from "node:events";
import { Effect } from "effect";

/** The public handler is onboarding-only; the raw OpenCode handler is never passed here. */
export const servePublic = (handler: (request: Request) => Promise<Response>, port: number) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const server = createServer((incoming, outgoing) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          headers.set(name, String(value));
        }
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const body = Buffer.concat(chunks);
          const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
            method: incoming.method!,
            headers,
            ...(body.length ? { body } : {}),
          });
          void handler(request)
            .then(async (response) => {
              outgoing.writeHead(response.status, Object.fromEntries(response.headers));
              outgoing.end(Buffer.from(await response.arrayBuffer()));
              return undefined;
            })
            .catch(() => outgoing.destroy());
        });
      });
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      return server;
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
  );
