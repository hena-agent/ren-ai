import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export const verifyTurnstile = (token: string, secret: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    ).pipe(HttpClientRequest.bodyUrlParams({ secret, response: token }), client.execute);
    if (response.status !== 200) return false;
    const body = yield* response.json;
    return (
      typeof body === "object" && body !== null && "success" in body && body["success"] === true
    );
  });
