import { Clock, Effect, Queue, Result, Schema } from "effect";
import type { Messages } from "@ren-ai/imsg";
import { remoteMessages } from "@ren-ai/imsg/client";
import { FetchHttpClient } from "effect/unstable/http";
import { logEvent, safeError } from "./gateway.ts";

const snapshot = Schema.Struct({
  rowID: Schema.Number,
  watched: Schema.Array(
    Schema.Struct({
      guid: Schema.String,
      handle: Schema.String,
      text: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
});
const window = 15 * 60_000;

/** Transport observations only. Cloudflare owns admission, retries and all durable state. */
const watchApplication = (messages: Messages, origin: string, token: string) => {
  const request = (path: string, method: "GET" | "POST") =>
    Effect.tryPromise(async () => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error("Application notification unavailable"), {
          status: response.status,
        });
      }
      return response;
    });
  return Effect.gen(function* () {
    const response = yield* request("/management/intake/watch", "GET");
    const initial = yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(snapshot)),
    );
    const watched = new Map(initial.watched.map((row) => [row.guid, row]));
    const pending = yield* Queue.sliding<void>(1);
    const signal = Queue.offer(pending, undefined).pipe(Effect.asVoid);
    yield* Effect.acquireRelease(
      messages.follow(initial.rowID, (row) =>
        Effect.gen(function* () {
          if (!row.fromMe && row.text && row.createdAt + window >= (yield* Clock.currentTimeMillis))
            watched.set(row.guid, row);
          yield* signal;
        }),
      ),
      (stop) => Effect.sync(stop),
    );
    const edits = Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("10 seconds");
        const now = yield* Clock.currentTimeMillis;
        for (const [guid, row] of watched) if (row.createdAt + window < now) watched.delete(guid);
        const handles = new Set([...watched.values()].map((row) => row.handle));
        for (const handle of handles) {
          const rows = yield* messages.recent(handle, now - window);
          for (const row of rows) {
            const previous = watched.get(row.guid);
            if (!previous || previous.text === row.text) continue;
            watched.set(row.guid, row);
            yield* signal;
          }
        }
      }),
    );
    const deliver = Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(pending);
        // Combine bursts without delaying subsequent signals received during delivery.
        yield* Effect.sleep("250 millis");
        yield* Queue.clear(pending);
        let attempts = 0;
        const requestId = crypto.randomUUID();
        const started = yield* Clock.currentTimeMillis;
        for (;;) {
          const result = yield* request("/management/intake/wake", "POST").pipe(Effect.result);
          if (Result.isSuccess(result)) {
            yield* Effect.promise(() => result.success.body?.cancel() ?? Promise.resolve());
            break;
          }
          reportWatchFailure(
            result.failure,
            "wake.delivery",
            requestId,
            (yield* Clock.currentTimeMillis) - started,
            attempts++,
          );
          yield* Effect.sleep(Math.min(1000 * 2 ** Math.min(attempts - 1, 8), 300_000));
        }
      }),
    );
    yield* Effect.all([edits, deliver], { concurrency: "unbounded" });
  });
};

const reportWatchFailure = (
  cause: Error,
  stage: string,
  requestId: string,
  durationMs: number,
  attempt: number,
) => {
  const root = cause.cause instanceof Error ? cause.cause : cause;
  logEvent("error", {
    service: "api-msg",
    requestId,
    operation: "application.watch",
    stage,
    outcome: "failed",
    level: "error",
    durationMs,
    attempt,
    ...safeError(root, "WATCH_UNAVAILABLE"),
    ...("status" in root && typeof root.status === "number" ? { upstreamStatus: root.status } : {}),
  });
};

export const runApplicationWatch = (
  url: string,
  token: string,
  imsgUrl: string,
  imsgToken: string,
) => {
  let attempts = 0;
  return Effect.forever(
    Effect.scoped(
      Effect.gen(function* () {
        const messages = yield* remoteMessages({ url: imsgUrl, token: imsgToken });
        yield* watchApplication(messages, url.replace(/\/$/, ""), token);
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          reportWatchFailure(cause, "watch.reconnect", crypto.randomUUID(), 0, attempts++);
          yield* Effect.sleep(Math.min(1000 * 2 ** Math.min(attempts, 8), 300_000));
        }),
      ),
    ),
  ).pipe(Effect.provide(FetchHttpClient.layer));
};
