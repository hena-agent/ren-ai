import type { createEmbeddedRoutes } from "@opencode/server/routes";
import { OpenCode } from "@opencode/client/effect";
import { Context, Effect, Layer, Scope } from "effect";
import {
  FetchHttpClient,
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http";
import { exportLocation } from "./session-transfer.ts";

/** Read only a throwaway COPY: native migrations may change it. No restart sweep/listener. */
export const exportOffline = (routes: ReturnType<typeof createEmbeddedRoutes>, directory: string) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(routes.pipe(Layer.provide(HttpServer.layerServices)));
    const web = HttpEffect.toWebHandlerWith<
      typeof services extends Context.Context<infer Provided> ? Provided : never,
      Scope.Scope | HttpServerRequest.HttpServerRequest
    >(services)(Context.get(services, HttpRouter.HttpRouter).asHttpEffect());
    const client = yield* OpenCode.make({ baseUrl: "http://offline.invalid" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => web(new Request(input, init))),
    );
    return yield* exportLocation(client, directory);
  });
