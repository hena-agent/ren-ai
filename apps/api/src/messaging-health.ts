import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { remoteMessages } from "@ren-ai/imsg/client";
import type { CloudflareConfiguration } from "./cloudflare-config.ts";

/** No-send probe reaches the running bridge's APNs ping and registration readiness. */
export const probeMessaging = (
  config: CloudflareConfiguration["execution"],
  fetcher: typeof fetch,
) =>
  Effect.scoped(
    remoteMessages({ url: config.imsgRpcUrl, token: config.managementToken }).pipe(
      Effect.flatMap((messages) => messages.probe()),
      Effect.timeout("5 seconds"),
    ),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetcher),
  );
