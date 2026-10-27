import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { createApplicationStore, type ApplicationStore } from "../src/application-store.ts";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { registrationSchemaProbe } from "./registration-schema.test-helper.ts";
import { usageBudget } from "./usage-budget.test-helper.ts";
import { outboxBudget } from "./outbox-budget.test-helper.ts";
import { changeAlert } from "../src/metrics/discord.ts";
import { metricsBudget } from "./metrics-budget.test-helper.ts";
import { blockedContact } from "./blocked-contact.test-helper.ts";
export { ActivityStore } from "./activity-store.test-helper.ts";

interface RegistryNamespace {
  idFromName: (name: string) => string;
  get: (id: string) => { fetch: (request: Request) => Promise<Response> };
}

interface Environment {
  readonly REGISTRY: RegistryNamespace;
  readonly TOKEN_MANAGEMENT: string;
  readonly ACTIVITY_STORE: RegistryNamespace;
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
  private posts: { content: string; wait: string | null }[] = [];
  private discordStatus = 200;
  private discordGlobal = false;
  private failActivity = false;
  private activityReads = 0;

  private application() {
    this.store ??= createApplicationStore(this.ctx.storage, {
      catalog,
      turnstileSecret: "test-secret",
      managementToken: this.env.TOKEN_MANAGEMENT,
      httpClient,
      activity: async () => {
        this.activityReads++;
        return this.failActivity ? new Response(null, { status: 503 }) : Response.json([]);
      },
      webhooks: {
        alerts: "https://discord.example/alerts",
        reports: "https://discord.example/reports",
      },
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        const body = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ content: Schema.String })),
        )(await request.text());
        this.posts.push({
          content: body.content,
          wait: new URL(request.url).searchParams.get("wait"),
        });
        return Response.json(
          { global: this.discordGlobal, retry_after: 120 },
          {
            status: this.discordStatus,
            headers: { "Retry-After": "120" },
          },
        );
      },
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
    if (path === "/__fixture/blocked-contact")
      return Response.json(
        await store.run(blockedContact(new URL(request.url).searchParams.has("during"))),
      );
    if (path === "/__fixture/metrics-budget")
      return Response.json(await metricsBudget(this.ctx.storage, store));
    if (path === "/__fixture/metrics-tick") {
      const params = new URL(request.url).searchParams;
      this.discordStatus = Number(params.get("status") ?? "200");
      this.discordGlobal = params.has("global");
      this.failActivity = params.get("activity") === "fail";
      const now = Date.now;
      Date.now = () => Number(params.get("at"));
      let reportDue: number | undefined;
      try {
        const [report] = await store.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ due: number }>`SELECT due FROM metrics_report WHERE id = 1`;
          }),
        );
        reportDue = report!.due;
        if (params.has("alerts")) {
          await store.run(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* changeAlert("screen-locked", true).pipe(
                Effect.andThen(changeAlert("disk-nearly-full", true)),
                sql.withTransaction,
              );
            }),
          );
        }
        await store.metricsTick(crypto.randomUUID());
      } finally {
        Date.now = now;
      }
      return Response.json(this.posts.splice(0), {
        headers: {
          "X-Activity-Reads": String(this.activityReads),
          "X-Metrics-Report-Due": String(reportDue),
        },
      });
    }
    if (path === "/__fixture/verify-imessage") {
      this.ctx.storage.sql.exec(
        "UPDATE discovery_registration SET imessage_status = 'available', imessage_checked_at = ?",
        Date.now(),
      );
      return Response.json({ ok: true });
    }
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
    if (new URL(request.url).pathname === "/__activity/")
      return env.ACTIVITY_STORE.get(env.ACTIVITY_STORE.idFromName("activity")).fetch(request);
    const id = env.REGISTRY.idFromName(
      new URL(request.url).pathname === "/__fixture/legacy-registration" ? "legacy" : "application",
    );
    return env.REGISTRY.get(id).fetch(request);
  },
};
