import { createServer } from "node:http";
import { once } from "node:events";
import { createPersonaStore } from "@ren-ai/personas";
import { Effect } from "effect";

export async function startTestCatalog(directory: string) {
  const store = await createPersonaStore(directory);
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let reply: Response;
        if (request.url === "/api/catalog") {
          if (request.headers.authorization !== "Bearer catalog-test")
            reply = new Response(null, { status: 401 });
          else {
            const personas = (await store.list()).map((persona) => ({
              persona,
              state: "",
              memory: "",
            }));
            reply = Response.json({ revision: JSON.stringify(personas), personas });
          }
        } else if (request.url === "/api/personas") reply = Response.json(await store.publicList());
        else reply = new Response(null, { status: 404 });
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(Buffer.from(await reply.arrayBuffer()));
      } catch {
        response.writeHead(503);
        response.end();
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test Catalog listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token: "catalog-test",
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const testCatalog = (directory: string) =>
  Effect.acquireRelease(
    Effect.promise(() => startTestCatalog(directory)),
    (catalog) => Effect.promise(catalog.close),
  );
