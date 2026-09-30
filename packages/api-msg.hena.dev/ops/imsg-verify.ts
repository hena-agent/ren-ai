import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { remoteMessages } from "../src/gateway/client.ts";

const token = process.env["IMSG_TOKEN"];
if (!token) throw new Error("IMSG_TOKEN is required");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* remoteMessages({
        url: process.env["IMSG_URL"] ?? "http://127.0.0.1:4702/rpc",
        token,
      });
      yield* service.probe();
    }),
  ).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write("Authenticated Messages DB/UI probe passed; no message sent.\n");
