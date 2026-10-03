import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";
import { authorize } from "./authorization.ts";

export { rpcClient } from "@ren-ai/plugin-application/rpc";

export const rpcRouter = (
  routes: Layer.Layer<never, never, HttpRouter.HttpRouter | RpcSerialization.RpcSerialization>,
  token: string,
) => {
  const web = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provide(HttpServer.layerServices),
    ),
  );
  return { dispose: web.dispose, handler: authorize(web.handler, token) };
};
