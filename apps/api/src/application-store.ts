import { SqliteClient } from "@effect/sql-sqlite-do";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { migrate } from "./database.ts";
import { checkAssignments } from "./discovery/assignment.ts";
import { contacts } from "./discovery/contacts.ts";
import { contactManagement } from "./discovery/management.ts";
import { makeDiscoveryWeb } from "./discovery/discovery.ts";
import type { PublicPersona } from "@ren-ai/onboarding";
import { authorize } from "@ren-ai/transport/server";
import { conversationStatus } from "./conversations/status.ts";
import { conversationRecords, requestOperatorEnding } from "./conversations/http.ts";
import { usageQueries } from "./usage/query.ts";

export interface ApplicationStoreConfig {
  readonly catalog: () => Promise<readonly PublicPersona[]>;
  readonly turnstileSecret: string;
  readonly managementToken: string;
  readonly httpClient: HttpClient.HttpClient;
}

export interface ApplicationStore {
  readonly context: Context.Context<SqlClient.SqlClient>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Promise<A>;
  readonly handler: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

/**
 * Opens one scoped SQLite client for this Durable Object instance. All public
 * registration and operator admission requests use that same SQL context.
 */
export const createApplicationStore = async (
  storage: DurableObjectStorage,
  config: ApplicationStoreConfig,
): Promise<ApplicationStore> => {
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(SqliteClient.layer({ storage }), scope),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(Effect.provideContext(effect, context));
  try {
    await run(migrate);
    await run(checkAssignments);
    const contactsStore = await run(contacts(config.catalog));
    const discovery = await run(
      makeDiscoveryWeb({
        catalog: config.catalog,
        turnstileSecret: config.turnstileSecret,
      }),
    );
    const management = contactManagement(contactsStore, config.managementToken);
    const statusStore = await run(conversationStatus(config.catalog));
    const usage = await run(usageQueries);
    const records = conversationRecords(statusStore, (effect) => Effect.runPromise(effect), usage);
    const privateRecords = config.managementToken
      ? authorize(
          (request) =>
            request.method === "POST" ? requestOperatorEnding(request, run) : records(request),
          config.managementToken,
        )
      : async () => new Response("Unauthorized", { status: 401 });
    const httpContext = Context.make(HttpClient.HttpClient, config.httpClient);
    return {
      context,
      run,
      handler: (request) => {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/discovery/")) return discovery.handler(request, httpContext);
        if (path.startsWith("/management/conversations")) return privateRecords(request);
        if (path.startsWith("/management/")) return management(request);
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      },
      close: async () => {
        await discovery.dispose();
        await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
      },
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.fail(cause)));
    throw cause;
  }
};
