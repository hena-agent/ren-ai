import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { createApplicationStore, type ApplicationStore } from "../src/application-store.ts";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { registrationSchemaProbe } from "./registration-schema.test-helper.ts";
import { usageBudget } from "./usage-budget.test-helper.ts";
import { outboxBudget } from "./outbox-budget.test-helper.ts";

interface RegistryNamespace {
  idFromName: (name: string) => string;
  get: (id: string) => { fetch: (request: Request) => Promise<Response> };
}

interface Environment {
  readonly REGISTRY: RegistryNamespace;
  readonly TOKEN_MANAGEMENT: string;
}

const catalog = async () => [
  {
    id: "sora",
    name: "Sora",
    bio: "A musician",
    imageUrl: "https://example.test/sora.jpg",
    publicProfile: "A musician",
  },
  {
    id: "luna",
    name: "Luna",
    bio: "A painter",
    imageUrl: "https://example.test/luna.jpg",
    publicProfile: "A painter",
  },
];

const httpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
);

export class Registry extends DurableObject<Environment> {
  private store: Promise<ApplicationStore> | undefined;

  private application() {
    this.store ??= createApplicationStore(this.ctx.storage, {
      catalog,
      turnstileSecret: "test-secret",
      managementToken: this.env.TOKEN_MANAGEMENT,
      httpClient,
    });
    return this.store;
  }

  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/__fixture/legacy-registration") {
      return Response.json(
        await Effect.runPromise(
          Effect.scoped(registrationSchemaProbe).pipe(
            Effect.provide(SqliteClient.layer({ storage: this.ctx.storage })),
          ),
        ),
      );
    }
    const store = await this.application();
    if (path === "/__fixture/outbox-budget")
      return Response.json(await outboxBudget(this.ctx.storage, store));
    if (path === "/__fixture/usage-budget")
      return Response.json(await usageBudget(this.ctx.storage, store));
    if (path === "/__fixture/test-handle") {
      const { handle } = Schema.decodeUnknownSync(Schema.Struct({ handle: Schema.String }))(
        await request.json(),
      );
      await store.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT OR IGNORE INTO test_handle (handle) VALUES (${handle})`;
        }),
      );
      return Response.json({ ok: true });
    }
    if (path === "/__fixture/state") {
      const state = await store.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const registrations = yield* sql`
            SELECT id, handle FROM discovery_registration ORDER BY handle`;
          const selections = yield* sql`
            SELECT request_id AS requestId FROM discovery_selection ORDER BY request_id`;
          const assignments = yield* sql`
            SELECT persona_id AS personaID, handle FROM persona_assignment ORDER BY persona_id`;
          return { registrations, selections, assignments };
        }),
      );
      return Response.json(state);
    }
    if (path === "/__fixture/reopen-conflict") {
      await store.close();
      this.store = undefined;
      this.ctx.storage.sql.exec(`INSERT INTO user
        (handle, locale, consent_version, consent_language, consent_at, persona_id)
        VALUES ('+10000000001', 'en', 'test', 'en', 1, 'duplicate'),
          ('+10000000002', 'en', 'test', 'en', 1, 'duplicate')`);
      try {
        await this.application();
        return Response.json({ initialized: true });
      } catch {
        this.store = undefined;
        return Response.json({ initialized: false });
      }
    }
    return store.handler(request);
  }
}

export default {
  fetch(request: Request, env: Environment) {
    const id = env.REGISTRY.idFromName(
      new URL(request.url).pathname === "/__fixture/legacy-registration" ? "legacy" : "application",
    );
    return env.REGISTRY.get(id).fetch(request);
  },
};
