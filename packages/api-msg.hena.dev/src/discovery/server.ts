import { Context, Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { createPersonaStore } from "@ren-ai/personas";
import { migrate } from "../database.ts";
import { servePublic } from "../public-listener.ts";
import { makeDiscoveryWeb } from "./discovery.ts";

export const startDiscovery = ({
  personaDirectory,
  turnstileSecret,
  port,
}: {
  personaDirectory: string;
  turnstileSecret: string;
  port: number;
}) =>
  Effect.gen(function* () {
    yield* migrate;
    const store = yield* Effect.tryPromise(() => createPersonaStore(personaDirectory));
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
