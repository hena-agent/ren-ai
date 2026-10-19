import { normalizeHandle } from "@ren-ai/onboarding";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";

const handlePayload = Schema.Struct({ handle: Schema.String });
const error = Schema.Struct({ reason: Schema.String }).pipe(HttpApiSchema.status(503));
const normalized = (handle: string) =>
  Effect.gen(function* () {
    const value = normalizeHandle(handle);
    if (!value) return yield* Effect.fail(new Error("Invalid Handle"));
    return value;
  });

export const operatorApi = HttpApi.make("operator").add(
  HttpApiGroup.make("operator")
    .add(
      HttpApiEndpoint.post("releaseSend", "/release-send", {
        payload: Schema.Struct({
          handle: Schema.String,
          callID: Schema.String.check(Schema.isMinLength(1)),
        }),
        success: Schema.Struct({
          result: Schema.Literals(["released", "settled", "uncertain", "not_found"]),
        }),
        error,
      }),
    )
    .add(
      HttpApiEndpoint.post("testHandle", "/test-handle", {
        payload: Schema.Struct({ handle: Schema.String, enabled: Schema.Boolean }),
        success: Schema.Void,
        error,
      }),
    )
    .add(
      HttpApiEndpoint.post("remove", "/remove", {
        payload: handlePayload,
        success: Schema.Struct({ result: Schema.Literals(["removed", "not_found"]) }),
        error,
      }),
    )
    .add(
      HttpApiEndpoint.post("block", "/block", {
        payload: handlePayload,
        success: Schema.Struct({ blocked: Schema.Boolean }),
        error,
      }),
    )
    .add(
      HttpApiEndpoint.post("rebuild", "/rebuild", {
        payload: handlePayload,
        success: Schema.Struct({ result: Schema.Literals(["rebuilt", "not_found", "present"]) }),
        error,
      }),
    ),
);

type Operations = {
  readonly releaseSend: (
    handle: string,
    callID: string,
  ) => Effect.Effect<"released" | "settled" | "uncertain" | "not_found", Error>;
  readonly testHandle: (handle: string, enabled: boolean) => Effect.Effect<void, Error>;
  readonly block: (handle: string) => Effect.Effect<void, Error>;
  readonly remove: (handle: string) => Effect.Effect<"removed" | "not_found", Error>;
  readonly rebuild?: (handle: string) => Effect.Effect<"rebuilt" | "not_found" | "present", Error>;
};

export const operatorHandler = (operations: Operations) => {
  const handlers = HttpApiBuilder.group(operatorApi, "operator", (group) =>
    group
      .handle("releaseSend", ({ payload }) =>
        Effect.suspend(() => {
          const requestId = crypto.randomUUID();
          const started = performance.now();
          const fields = { requestId, operation: "send.release", stage: "outbox.reconcile" };
          return normalized(payload.handle).pipe(
            Effect.flatMap((handle) => operations.releaseSend(handle, payload.callID)),
            Effect.tap((result) =>
              Effect.sync(() =>
                contactLog({
                  ...fields,
                  outcome: "completed",
                  code: result,
                  level: result === "uncertain" ? "warn" : "info",
                  durationMs: performance.now() - started,
                }),
              ),
            ),
            Effect.tapError((cause) =>
              Effect.sync(() =>
                contactLog({
                  ...fields,
                  ...contactCause(cause),
                  outcome: "failed",
                  level: "error",
                  durationMs: performance.now() - started,
                }),
              ),
            ),
            Effect.map((result) => ({ result })),
            Effect.mapError(() => ({ reason: `Send recovery failed (request ${requestId})` })),
          );
        }),
      )
      .handle("testHandle", ({ payload }) =>
        normalized(payload.handle).pipe(
          Effect.flatMap((handle) => operations.testHandle(handle, payload.enabled)),
          Effect.mapError((failure) => ({ reason: String(failure) })),
        ),
      )
      .handle("remove", ({ payload }) =>
        normalized(payload.handle).pipe(
          Effect.flatMap((handle) => operations.remove(handle)),
          Effect.map((result) => ({ result })),
          Effect.mapError((failure) => ({ reason: String(failure) })),
        ),
      )
      .handle("block", ({ payload }) =>
        normalized(payload.handle).pipe(
          Effect.flatMap((handle) => operations.block(handle)),
          Effect.as({ blocked: true }),
          Effect.mapError((failure) => ({ reason: String(failure) })),
        ),
      )
      .handle("rebuild", ({ payload }) =>
        normalized(payload.handle).pipe(
          Effect.flatMap(
            (handle) => operations.rebuild?.(handle) ?? Effect.succeed("not_found" as const),
          ),
          Effect.map((result) => ({ result })),
          Effect.mapError((failure) => ({ reason: String(failure) })),
        ),
      ),
  );
  return HttpRouter.toWebHandler(
    HttpApiBuilder.layer(operatorApi).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provide(HttpServer.layerServices),
    ),
  );
};
