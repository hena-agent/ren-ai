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
import { submissionLimit, verificationLimit } from "./rate-limit.ts";
import { verifyTurnstile } from "./turnstile.ts";
import { reselect, withoutEndedPersonas } from "./reselection.ts";
import { contactCause, contactLog, type ContactLog } from "./diagnostics.ts";
import { queueWaitlistNotification } from "./notifications.ts";
import { publicCatalog } from "../personas/public-catalog.ts";

const failure = Schema.Literals([
  "consent",
  "verification",
  "personas",
  "unavailable",
  "try_later",
  "reselection",
]).pipe(HttpApiSchema.status(400));
const failures = [failure, Schema.Literal("storage").pipe(HttpApiSchema.status(503))];
const namespace = "/discovery";
const operationID = (parent: string | undefined) =>
  parent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parent) ? parent : randomUUID();
const discoveryApi = HttpApi.make(namespace).add(
  HttpApiGroup.make("discovery")
    .add(
      HttpApiEndpoint.get("personas", `${namespace}/personas`, {
        success: Schema.Array(PublicPersona),
        error: failures,
      }),
    )
    .add(
      HttpApiEndpoint.post("join", `${namespace}/waitlist`, {
        payload: DiscoveryRequest,
        success: DiscoveryAnswer,
        error: failures,
      }),
    ),
);

export const makeDiscoveryWeb = ({
  catalog,
  turnstileSecret,
  log = contactLog,
}: {
  catalog: () => Promise<readonly PublicPersona[]>;
  turnstileSecret: string;
  log?: ContactLog;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const clock = yield* Clock.Clock;
    const limit = yield* submissionLimit;
    const verification = yield* verificationLimit;
    const cached = yield* publicCatalog(catalog, log);
    const checkedLimit = (check: Effect.Effect<boolean, Error>, requestId: string, stage: string) =>
      check.pipe(
        Effect.tapError((cause) =>
          Effect.sync(() =>
            log({
              requestId,
              operation: "discovery.registration",
              stage,
              code: "storage",
              level: "error",
              outcome: "failed",
              durationMs: 0,
              ...contactCause(cause),
            }),
          ),
        ),
        Effect.mapError(() => "storage" as const),
      );
    const profiles = (requestId: string, fresh = false) =>
      Effect.gen(function* () {
        const started = performance.now();
        const source = fresh
          ? Effect.tryPromise({
              try: catalog,
              catch: (cause) => new Error("Public Catalog unavailable", { cause }),
            })
          : cached.read(requestId);
        return yield* source.pipe(
          Effect.flatMap(withoutEndedPersonas),
          Effect.tapError((cause) =>
            Effect.sync(() =>
              log({
                requestId,
                operation: "discovery.catalog",
                stage: "catalog.read",
                outcome: "failed",
                level: "error",
                code: "storage",
                durationMs: performance.now() - started,
                ...contactCause(cause),
              }),
            ),
          ),
          Effect.mapError(() => "storage" as const),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Clock.Clock, clock),
        );
      });
    const join = (input: DiscoveryRequest, requestId: string, ip: string | undefined) =>
      Effect.gen(function* () {
        const started = performance.now();
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
        if (
          yield* checkedLimit(
            limit(ip, yield* Clock.currentTimeMillis),
            requestId,
            "registration.limit",
          )
        )
          return yield* Effect.fail("try_later" as const);
        const available = new Set((yield* profiles(requestId, true)).map((persona) => persona.id));
        if (!input.likedPersonaIDs.every((id) => available.has(id)))
          return yield* Effect.fail("personas" as const);
        return yield* Effect.gen(function* () {
          const blocked = yield* sql`SELECT handle FROM blocked WHERE handle = ${input.handle}
        UNION SELECT handle FROM removal WHERE handle = ${input.handle}`;
          if (blocked.length) return yield* Effect.fail("unavailable" as const);
          const active =
            yield* sql`SELECT u.id FROM user u WHERE u.handle = ${input.handle} AND u.joined_at IS NOT NULL
              AND (EXISTS(SELECT 1 FROM conversation c WHERE c.user_id = u.id AND c.ended_at IS NULL)
                OR NOT EXISTS(SELECT 1 FROM conversation c WHERE c.user_id = u.id AND c.ended_at IS NOT NULL))`;
          if (active.length) return { status: "active" as const };
          const existing = yield* sql`SELECT id FROM user WHERE handle = ${input.handle}`;
          if (existing.length) {
            yield* reselect(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            return { status: "waiting" as const };
          }
          if (input.reselectionToken) return yield* Effect.fail("reselection" as const);
          const id = randomUUID();
          const created = yield* Clock.currentTimeMillis;
          const inserted =
            yield* sql`INSERT OR IGNORE INTO discovery_registration (id, handle, locale, consent_version, created_at, starting_relationship)
        VALUES (${id}, ${input.handle}, ${input.locale}, ${input.privacyNoticeVersion}, ${created}, ${input.startingRelationship ?? "dating"}) RETURNING id`;
          if (inserted.length) {
            yield* sql`INSERT INTO discovery_profile (registration_id, name, age, gender)
              VALUES (${id}, ${input.name ?? null}, ${input.age ?? null}, ${input.gender ?? null})`;
            yield* sql`INSERT INTO discovery_language (registration_id, conversation_language)
              VALUES (${id}, ${input.conversationLanguage ?? input.locale})`;
            for (const personaID of input.likedPersonaIDs)
              yield* sql`INSERT INTO discovery_like (registration_id, persona_id) VALUES (${id}, ${personaID})`;
            yield* queueWaitlistNotification(id, created).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          }
          return { status: "waiting" as const };
        }).pipe(
          sql.withTransaction,
          Effect.tapError((error) =>
            Effect.sync(() =>
              contactLog({
                requestId,
                operation: "discovery.registration",
                stage: "registration.commit",
                code: typeof error === "string" ? error : "storage",
                level: typeof error === "string" ? "warn" : "error",
                outcome: "failed",
                durationMs: performance.now() - started,
                ...(typeof error !== "string" && contactCause(error)),
              }),
            ),
          ),
          Effect.mapError((error) => (typeof error === "string" ? error : ("storage" as const))),
        );
      });
    const handlers = HttpApiBuilder.group(discoveryApi, "discovery", (group) =>
      group
        .handle("personas", () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* profiles(operationID(request.headers["x-operation-id"]));
          }),
        )
        .handle("join", ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const now = yield* Clock.currentTimeMillis;
            const requestId = operationID(request.headers["x-operation-id"]);
            if (
              yield* checkedLimit(
                verification(request.headers["cf-connecting-ip"], now),
                requestId,
                "verification.limit",
              )
            )
              return yield* Effect.fail("try_later" as const);
            return yield* join(payload, requestId, request.headers["cf-connecting-ip"]);
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
    return {
      ...web,
      handler: async (...args: Parameters<typeof web.handler>) => {
        const response = await web.handler(...args);
        const cacheable =
          args[0].method === "GET" &&
          new URL(args[0].url).pathname === "/discovery/personas" &&
          response.ok;
        response.headers.set(
          "Cache-Control",
          cacheable ? "public, max-age=60, stale-while-revalidate=300" : "no-store",
        );
        if (cacheable) {
          const [snapshot] = await Effect.runPromise(
            sql<{ loaded_at: number }>`SELECT loaded_at FROM public_catalog WHERE id = 1`,
          );
          response.headers.set(
            "Age",
            String(
              Math.max(
                0,
                Math.floor((clock.currentTimeMillisUnsafe() - snapshot!.loaded_at) / 1000),
              ),
            ),
          );
        }
        return response;
      },
    };
  });
