import { randomUUID } from "node:crypto";
import { Clock, Effect, Layer, Schema } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
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
  DiscoveryNotices,
  PublicPersona,
  BrowseQuery,
  BrowsePage,
  BrowseReselection,
  ProfileLookup,
  PersonaLink,
  discoveryNotice,
  discoveryNotices,
} from "@ren-ai/onboarding";
import { submissionLimit, verificationLimit } from "./rate-limit.ts";
import { verifyTurnstile } from "./turnstile.ts";
import { endedPersonaIDs, reselect, browsingHandle } from "./reselection.ts";
import { contactCause, contactLog, type ContactLog } from "./diagnostics.ts";
import { queueRegistrationNotification } from "./notifications.ts";
import { publicCatalog } from "../personas/public-catalog.ts";
import { browsePage, lookupProfiles } from "../personas/browse.ts";
import { registrationMetric } from "../metrics/lifecycle.ts";
import { failedJoin } from "../metrics/failures.ts";

const failure = Schema.Literals([
  "consent",
  "verification",
  "personas",
  "ended_personas",
  "unavailable",
  "reselection",
]).pipe(HttpApiSchema.status(400));
const failures = [
  failure,
  Schema.Literal("storage").pipe(HttpApiSchema.status(503)),
  Schema.Literal("try_later").pipe(HttpApiSchema.status(429)),
];
const namespace = "/discovery";
const operationID = (parent: string | undefined) =>
  parent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parent) ? parent : randomUUID();
const discoveryApi = HttpApi.make(namespace).add(
  HttpApiGroup.make("discovery")
    .add(HttpApiEndpoint.get("notices", `${namespace}/notices`, { success: DiscoveryNotices }))
    .add(
      HttpApiEndpoint.get("personas", `${namespace}/personas`, {
        query: BrowseQuery,
        success: BrowsePage,
        error: failures,
      }),
    )
    .add(
      HttpApiEndpoint.post("reselectionPersonas", `${namespace}/reselection/personas`, {
        payload: BrowseReselection,
        success: BrowsePage,
        error: failures,
      }),
    )
    .add(
      HttpApiEndpoint.post("profiles", `${namespace}/profiles`, {
        payload: ProfileLookup,
        success: Schema.Array(PublicPersona),
        error: failures,
      }),
    )
    .add(
      HttpApiEndpoint.get("personaLinks", `${namespace}/persona-links`, {
        success: Schema.Array(PersonaLink),
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
    const checkedLimit = (check: Effect.Effect<number, Error>, requestId: string, stage: string) =>
      Effect.suspend(() => {
        const started = performance.now();
        return check.pipe(
          Effect.tapError((cause) =>
            Effect.sync(() =>
              log({
                requestId,
                operation: "discovery.registration",
                stage,
                code: "storage",
                level: "error",
                outcome: "failed",
                durationMs: performance.now() - started,
                ...contactCause(cause),
              }),
            ),
          ),
          Effect.mapError(() => "storage" as const),
          Effect.flatMap((seconds) =>
            Effect.gen(function* () {
              if (!seconds) return undefined;
              yield* HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(
                  HttpServerResponse.setHeader(response, "Retry-After", String(seconds)),
                ),
              );
              log({
                requestId,
                operation: "discovery.registration",
                stage,
                code: "try_later",
                level: "warn",
                outcome: "failed",
                durationMs: performance.now() - started,
              });
              return yield* Effect.fail("try_later" as const);
            }),
          ),
        );
      });
    const catalogOperation = <A, E>(
      source: Effect.Effect<A, E, SqlClient.SqlClient>,
      requestId: string,
    ) =>
      Effect.gen(function* () {
        const started = performance.now();
        return yield* source.pipe(
          Effect.tapError((cause) =>
            Effect.sync(() => {
              log({
                requestId,
                operation: "discovery.catalog",
                stage: "catalog.read",
                outcome: "failed",
                level: cause === "personas" ? "warn" : "error",
                code: cause === "personas" ? "personas" : "storage",
                durationMs: performance.now() - started,
                ...contactCause(cause),
              });
            }),
          ),
          Effect.mapError((error) =>
            error === "personas" ? ("personas" as const) : ("storage" as const),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Clock.Clock, clock),
        );
      });
    const profiles = (requestId: string) =>
      catalogOperation(
        Effect.tryPromise({
          try: catalog,
          catch: (cause) => new Error("Public Catalog unavailable", { cause }),
        }),
        requestId,
      );
    const browsing = (query: BrowseQuery, requestId: string, handle = "") =>
      catalogOperation(
        Effect.gen(function* () {
          const revision = yield* cached.ensure(requestId);
          return yield* browsePage(query, revision, handle);
        }),
        requestId,
      );
    const join = (
      input: DiscoveryRequest,
      requestId: string,
      ip: string | undefined,
      country: string | null,
      systemFailure: () => void,
    ) =>
      Effect.gen(function* () {
        const started = performance.now();
        const reject = (
          code: "consent" | "verification",
          cause?: ReturnType<typeof contactCause>,
        ) =>
          Effect.gen(function* () {
            log({
              requestId,
              operation: "discovery.registration",
              stage: code,
              code,
              level: cause ? "error" : "warn",
              outcome: "failed",
              durationMs: performance.now() - started,
              ...cause,
            });
            return yield* Effect.fail(code);
          });
        if (
          discoveryNotice.version === "pending" ||
          input.privacyNoticeVersion !== discoveryNotice.version
        )
          return yield* reject("consent");
        let verificationCause: ReturnType<typeof contactCause> | undefined;
        if (
          !turnstileSecret ||
          !(yield* verifyTurnstile(input.turnstileToken, turnstileSecret).pipe(
            Effect.catch((cause) => {
              systemFailure();
              verificationCause = contactCause(cause);
              return Effect.succeed(false);
            }),
          ))
        )
          return yield* reject("verification", verificationCause);
        const publicProfiles = yield* profiles(requestId).pipe(
          Effect.tapError(() => Effect.sync(systemFailure)),
        );
        const available = new Set(publicProfiles.map((persona) => persona.id));
        return yield* Effect.gen(function* () {
          // Filter the submitted IDs, including personas that are no longer published.
          const endedIDs = yield* endedPersonaIDs(input.handle).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const likedPersonaIDs = input.likedPersonaIDs.filter((id) => !endedIDs.has(id));
          if (!likedPersonaIDs.length) return yield* Effect.fail("ended_personas" as const);
          if (!likedPersonaIDs.every((id) => available.has(id)))
            return yield* Effect.fail("personas" as const);
          yield* checkedLimit(
            limit(ip, yield* Clock.currentTimeMillis),
            requestId,
            "registration.limit",
          );
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
            yield* reselect({ ...input, likedPersonaIDs }, country).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
            return { status: "waiting" as const };
          }
          if (input.reselectionToken) return yield* Effect.fail("reselection" as const);
          const id = randomUUID();
          const created = yield* Clock.currentTimeMillis;
          const inserted =
            yield* sql`INSERT OR IGNORE INTO discovery_registration (id, handle, locale, consent_version, created_at, starting_relationship, image_style)
        VALUES (${id}, ${input.handle}, ${input.locale}, ${input.privacyNoticeVersion}, ${created}, ${input.startingRelationship ?? "dating"}, ${input.imageStyle ?? "anime"}) RETURNING id`;
          if (inserted.length) {
            yield* sql`INSERT INTO discovery_profile (registration_id, name, age, gender)
              VALUES (${id}, ${input.name}, ${input.age ?? null}, ${input.gender ?? null})`;
            yield* sql`INSERT INTO discovery_language (registration_id, conversation_language)
              VALUES (${id}, ${input.conversationLanguage ?? input.locale})`;
            for (const personaID of likedPersonaIDs)
              yield* sql`INSERT INTO discovery_like (registration_id, persona_id) VALUES (${id}, ${personaID})`;
            yield* registrationMetric(id, input, country, "first").pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          }
          return { status: "waiting" as const };
        }).pipe(
          Effect.tap(({ status }) =>
            queueRegistrationNotification(input, status, requestId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          ),
          sql.withTransaction,
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error === "try_later" || error === "storage") return;
              log({
                requestId,
                operation: "discovery.registration",
                stage:
                  error === "personas"
                    ? "catalog.selection"
                    : error === "ended_personas"
                      ? "selection.ended"
                      : "registration.commit",
                code: typeof error === "string" ? error : "storage",
                level: typeof error === "string" ? "warn" : "error",
                outcome: "failed",
                durationMs: performance.now() - started,
                ...(typeof error !== "string" && contactCause(error)),
              });
            }),
          ),
          Effect.mapError((error) => (typeof error === "string" ? error : ("storage" as const))),
        );
      });
    const authorizeAttempt = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const now = yield* Clock.currentTimeMillis;
      const requestId = operationID(request.headers["x-operation-id"]);
      yield* checkedLimit(
        verification(request.headers["cf-connecting-ip"], now),
        requestId,
        "verification.limit",
      );
      return { requestId, ip: request.headers["cf-connecting-ip"] };
    });
    const handlers = HttpApiBuilder.group(discoveryApi, "discovery", (group) =>
      group
        .handle("notices", () => Effect.succeed(discoveryNotices))
        .handle("personas", ({ query }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* browsing(query, operationID(request.headers["x-operation-id"]));
          }),
        )
        .handle("reselectionPersonas", ({ payload }) =>
          Effect.gen(function* () {
            const { requestId } = yield* authorizeAttempt;
            return yield* Effect.gen(function* () {
              const handle = yield* browsingHandle(payload.reselectionToken, requestId, log);
              return yield* browsing(payload, requestId, handle);
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          }),
        )
        .handle("profiles", ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestId = operationID(request.headers["x-operation-id"]);
            let handle = "";
            if (payload.reselectionToken !== undefined) {
              yield* authorizeAttempt;
              handle = yield* browsingHandle(payload.reselectionToken, requestId, log).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
            }
            return yield* catalogOperation(
              Effect.gen(function* () {
                yield* cached.ensure(requestId);
                return yield* lookupProfiles(payload.ids, handle);
              }),
              requestId,
            );
          }),
        )
        .handle("personaLinks", () =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* catalogOperation(
              Effect.gen(function* () {
                yield* cached.ensure(operationID(request.headers["x-operation-id"]));
                return yield* sql<{ id: string; imageUrl: string }>`SELECT id,
              COALESCE(json_extract(payload, '$.portraits.anime'), json_extract(payload, '$.imageUrl')) AS imageUrl
              FROM browse_live ORDER BY id`;
              }),
              operationID(request.headers["x-operation-id"]),
            );
          }),
        )
        .handle("join", ({ payload }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const country = payload.visitCountry ?? request.headers["cf-ipcountry"] ?? null;
            let system = !turnstileSecret;
            return yield* Effect.gen(function* () {
              const { requestId, ip } = yield* authorizeAttempt;
              return yield* join(payload, requestId, ip, country, () => {
                system = true;
              });
            }).pipe(
              Effect.tapError((reason) =>
                failedJoin(
                  payload,
                  reason,
                  country,
                  system || reason === "storage",
                  operationID(request.headers["x-operation-id"]),
                ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              ),
            );
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
            exposedHeaders: ["X-Request-ID", "Retry-After"],
          }),
        ),
      ),
    );
    return {
      ...web,
      handler: async (...args: Parameters<typeof web.handler>) => {
        const headers = new Headers(args[0].headers);
        const requestId = operationID(headers.get("x-operation-id") ?? undefined);
        headers.set("x-operation-id", requestId);
        args[0] = new Request(args[0], { headers });
        const response = await web.handler(...args);
        response.headers.set("X-Request-ID", requestId);
        response.headers.set("Cache-Control", "no-store");
        return response;
      },
    };
  });
