import { Config, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { operatorApi } from "./api.ts";

export interface OperatorConnection {
  readonly url: string;
  readonly token: string;
}

export const operatorConnection = Config.all({
  url: Config.string("API_APP_URL"),
  token: Config.string("TOKEN_MANAGEMENT"),
});

/** The API client validates responses against the shared operator schemas. */
export const operatorClient = (connection: OperatorConnection) =>
  HttpApiClient.make(operatorApi, {
    baseUrl: `${connection.url.replace(/\/$/, "")}/operator`,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader("authorization", `Bearer ${connection.token}`),
    ),
  }).pipe(Effect.provide(FetchHttpClient.layer));
