import { normalizeHandle } from "@repo/onboarding";
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
    ),
);

type Operations = {
  readonly block: (handle: string) => Effect.Effect<void, Error>;
  readonly remove: (handle: string) => Effect.Effect<"removed" | "not_found", Error>;
};

export const operatorHandler = (operations: Operations) => {
  const handlers = HttpApiBuilder.group(operatorApi, "operator", (group) =>
    group
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
