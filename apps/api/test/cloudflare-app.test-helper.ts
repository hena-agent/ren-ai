import { fromPartial } from "@total-typescript/shoehorn";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import type { CloudflareBindings } from "../src/cloudflare-config.ts";
import { migrate } from "../src/database.ts";

export type RuntimeDouble = {
  initialized: boolean;
  fetch: Mock<(request: Request) => Promise<Response>>;
  tick: Mock<() => Promise<void>>;
  close: Mock<() => Promise<void>>;
};

const controls = vi.hoisted(() => ({
  failStore: false,
  failDatabase: false,
  storeRun: vi.fn<() => Promise<void>>(async () => {
    if (controls.failDatabase) throw new Error("private database detail");
  }),
  storeHandler: vi.fn<(request: Request) => Promise<Response>>(
    async () => new Response("registry"),
  ),
  closeStore: vi.fn<() => Promise<void>>(async () => undefined),
  metricsTick: vi.fn<(requestId: string) => Promise<void>>(async () => {}),
  runtime: vi.fn<() => Promise<RuntimeDouble>>(async () => ({
    initialized: true,
    fetch: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("execution")),
    tick: vi.fn<() => Promise<void>>(async () => {}),
    close: vi.fn<() => Promise<void>>(async () => {}),
  })),
}));

export { controls };

vi.mock("../src/execution-runtime.ts", () => ({ createExecutionRuntime: controls.runtime }));

vi.mock("../src/application-store.ts", () => ({
  createApplicationStore: async () => {
    if (controls.failStore) throw new Error("registry startup failed");
    return {
      run: async (effect: Effect.Effect<void, Error, SqlClient.SqlClient>) => {
        await controls.storeRun();
        return Effect.runPromise(
          Effect.scoped(migrate.pipe(Effect.andThen(effect))).pipe(
            Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
          ),
        );
      },
      handler: controls.storeHandler,
      metricsTick: controls.metricsTick,
      close: controls.closeStore,
    };
  },
}));

export const storage = fromPartial<DurableObjectStorage>({ sql: { exec: vi.fn<() => never>() } });
export const bindings: CloudflareBindings = {
  PERSONA_CATALOG_URL: "https://admin.example",
  TOKEN_CATALOG: "catalog-token",
  TURNSTILE_SECRET: "turnstile-secret",
  TOKEN_MANAGEMENT: "management-token",
  API_MSG_URL: "https://api-msg.example",
};
export const fetcher: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.method === "POST") {
    const body = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
    )(await request.text());
    return new Response(
      `${JSON.stringify({ _tag: "Exit", requestId: body.id, exit: { _tag: "Success", value: null } })}\n`,
    );
  }
  return Response.json({ service: "api-msg", revision: "development", status: "ready" });
};
export const settledRuntime = () => {
  const result = controls.runtime.mock.settledResults.at(-1);
  if (result?.type !== "fulfilled") throw new Error("Execution did not open");
  return result.value;
};

afterEach(() => {
  controls.failStore = false;
  controls.failDatabase = false;
  controls.storeRun.mockClear();
  controls.storeHandler.mockClear();
  controls.closeStore.mockClear();
  controls.metricsTick.mockClear();
  controls.runtime.mockClear();
});
