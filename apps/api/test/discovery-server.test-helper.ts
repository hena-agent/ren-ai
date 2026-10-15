import { Context, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { catalogClient } from "../src/personas/catalog.ts";
import { migrate } from "../src/database.ts";
import { servePublic } from "@ren-ai/transport/listener";
import { makeDiscoveryWeb } from "../src/discovery/discovery.ts";

export const startDiscovery = ({
  catalogUrl,
  turnstileSecret,
  port,
}: {
  catalogUrl: string;
  turnstileSecret: string;
  port: number;
}) =>
  Effect.gen(function* () {
    yield* migrate;
    const store = catalogClient({ url: catalogUrl, token: "" });
    const client = yield* HttpClient.HttpClient;
    const web = yield* makeDiscoveryWeb({
      catalog: store.publicList,
      turnstileSecret,
      image: store.publicImage,
    });
    yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
    return yield* servePublic(
      (request) => web.handler(request, Context.make(HttpClient.HttpClient, client)),
      port,
    );
  });
