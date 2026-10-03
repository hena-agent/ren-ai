import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization, type Rpc, type RpcGroup } from "effect/unstable/rpc";

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
