import { randomUUID } from "node:crypto";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/unstable/httpapi";
import { SqlClient } from "effect/unstable/sql";
import {
  DiscoveryAnswer,
  DiscoveryRequest,
  PublicPersona,
  discoveryNotice,
} from "@ren-ai/onboarding";
import { submissionLimit } from "./rate-limit.ts";
import { verifyTurnstile } from "./turnstile.ts";

const failure = Schema.Literals([
  "consent",
  "verification",
  "personas",
  "unavailable",
  "try_later",
  "storage",
]).pipe(HttpApiSchema.status(400));
const namespace = "/discovery";
const discoveryApi = HttpApi.make(namespace).add(
  HttpApiGroup.make("discovery")
    .add(
      HttpApiEndpoint.get("personas", `${namespace}/personas`, {
        success: Schema.Array(PublicPersona),
        error: failure,
      }),
    )
    .add(
      HttpApiEndpoint.post("join", `${namespace}/waitlist`, {
        payload: DiscoveryRequest,
        success: DiscoveryAnswer,
        error: failure,
      }),
    ),
);

export const makeDiscoveryWeb = ({
  catalog,
  turnstileSecret,
  image,
}: {
  catalog: () => Promise<readonly PublicPersona[]>;
  turnstileSecret: string;
  image?: (filename: string) => Promise<Response>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = submissionLimit();
    const profiles = Effect.tryPromise({ try: catalog, catch: () => "storage" as const });
    const join = (input: DiscoveryRequest) =>
      Effect.gen(function* () {
        if (
          discoveryNotice.version === "pending" ||
          input.privacyNoticeVersion !== discoveryNotice.version
        )
          return yield* Effect.fail("consent" as const);
        if (
          !turnstileSecret ||
          !(yield* verifyTurnstile(input.turnstileToken, turnstileSecret).pipe(
            Effect.catch(() => Effect.succeed(false)),
          ))
        )
          return yield* Effect.fail("verification" as const);
        const available = new Set((yield* profiles).map((persona) => persona.id));
        if (!input.likedPersonaIDs.every((id) => available.has(id)))
          return yield* Effect.fail("personas" as const);
        return yield* Effect.gen(function* () {
          const blocked = yield* sql`SELECT handle FROM blocked WHERE handle = ${input.handle}
        UNION SELECT handle FROM removal WHERE handle = ${input.handle}`;
          if (blocked.length) return yield* Effect.fail("unavailable" as const);
          const active =
            yield* sql`SELECT id FROM user WHERE handle = ${input.handle} AND joined_at IS NOT NULL`;
          if (active.length) return { status: "active" as const };
          const id = randomUUID();
          const created = yield* Clock.currentTimeMillis;
          const inserted =
            yield* sql`INSERT OR IGNORE INTO discovery_registration (id, handle, locale, consent_version, created_at)
        VALUES (${id}, ${input.handle}, ${input.locale}, ${input.privacyNoticeVersion}, ${created}) RETURNING id`;
          if (inserted.length) {
            yield* sql`INSERT INTO discovery_language (registration_id, conversation_language)
              VALUES (${id}, ${input.conversationLanguage ?? input.locale})`;
            for (const personaID of input.likedPersonaIDs)
              yield* sql`INSERT INTO discovery_like (registration_id, persona_id) VALUES (${id}, ${personaID})`;
          }
          return { status: "waiting" as const };
        }).pipe(
          sql.withTransaction,
          Effect.mapError((error) => (typeof error === "string" ? error : ("storage" as const))),
        );
      });
    const handlers = HttpApiBuilder.group(discoveryApi, "discovery", (group) =>
      group
        .handle("personas", () => profiles)
        .handle("join", ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const now = yield* Clock.currentTimeMillis;
            if (limit(request.headers["cf-connecting-ip"], now))
              return yield* Effect.fail("try_later" as const);
            return yield* join(payload);
          }),
        ),
    );
    const web = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(discoveryApi).pipe(
        Layer.provide(handlers),
        Layer.provideMerge(HttpRouter.layer),
        Layer.provide(HttpServer.layerServices),
        Layer.provide(
          HttpRouter.cors({
            allowedOrigins: ["https://renai.im"],
          }),
        ),
      ),
    );
    const handler: typeof web.handler = (request, context) => {
      const pathname = new URL(request.url).pathname;
      if (image && pathname.startsWith("/discovery/images/")) {
        if (request.method !== "GET")
          return Promise.resolve(new Response(null, { status: 405, headers: { Allow: "GET" } }));
        const start = performance.now();
        return image(pathname.slice("/discovery/images/".length)).catch(async (cause) => {
          const id = randomUUID();
          const error = cause instanceof Error ? cause : new Error("Image read failed");
          const root = error.cause instanceof Error ? error.cause : error;
          const code =
            "code" in root && (typeof root.code === "string" || typeof root.code === "number")
              ? String(root.code).slice(0, 100)
              : undefined;
          await Effect.runPromise(
            Effect.logError({
              operation: "discovery.image",
              stage: "catalog.image",
              outcome: "failed",
              requestId: id,
              causeName: root.name.slice(0, 100),
              ...(code && { code }),
              durationMs: performance.now() - start,
            }),
          );
          return new Response(null, { status: 503, headers: { "X-Request-ID": id } });
        });
      }
      return web.handler(request, context);
    };
    return { ...web, handler };
  });
