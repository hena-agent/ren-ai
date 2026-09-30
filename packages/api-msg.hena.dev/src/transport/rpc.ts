import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization, type Rpc, type RpcGroup } from "effect/unstable/rpc";
import { authorize } from "./authorization.ts";

export const rpcClient = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  config: { readonly url: string; readonly token: string },
) =>
  RpcClient.make(group).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: config.url,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader("authorization", `Bearer ${config.token}`),
        ),
      }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  );

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
