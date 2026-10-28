import { fromPartial } from "@total-typescript/shoehorn";
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { vi } from "vitest";
import type { folderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import type { Session } from "@opencode/schema/session";
import type { RemoteConfig } from "../src/opencode/remote.ts";
import type {
  SessionActiveOutput,
  MessageListInput,
  MessageListOutput,
} from "@opencode/client/effect/api";

const control = vi.hoisted(() => ({
  events: [] as string[],
  failure: "",
  requests: [] as string[],
  startup: async () => {},
  callback: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("callback")),
  operator: vi.fn<(request: Request) => Promise<Response>>(async () => new Response("operator")),
  folderRead: vi.fn<() => Effect.Effect<typeof folderSnapshot.Type, Error>>(),
  languageFailure: undefined as Error | undefined,
  activeRead: vi.fn<() => Effect.Effect<SessionActiveOutput, Error>>(),
  activeProbe: vi.fn<(id: Session.ID) => Effect.Effect<boolean, Error>>(),
  onPrompt: vi.fn<(id: string) => Effect.Effect<void, Error>>(),
  usageApi: undefined as
    | {
        messages: (input: MessageListInput) => Effect.Effect<MessageListOutput, Error>;
        get: (id: Session.ID) => Effect.Effect<Session.Info, Error>;
      }
    | undefined,
  removeSession: undefined as ((id: Session.ID) => Effect.Effect<void, Error>) | undefined,
}));
export { control };

const step = (name: string) =>
  Effect.sync(() => {
    control.events.push(name);
    if (control.failure === name) throw new Error(`failed ${name}`);
  });

vi.mock("../src/personas/catalog.ts", () => ({
  catalogClient: () => ({
    load: async () => {
      control.events.push("catalog");
      if (control.failure === "catalog") throw new Error("catalog unavailable");
      return {
        revision: String(control.events.filter((event) => event === "catalog").length),
        personas: new Map(),
      };
    },
  }),
}));
vi.mock("@ren-ai/imsg/client", () => ({
  remoteMessages: () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      yield* client.post("https://api-msg.example/imsg/rpc/");
      return { gestures: {}, probe: () => Effect.void };
    }),
}));
vi.mock("../src/alerts.ts", () => ({
  applicationAlerts: Effect.succeed({ raise: () => Effect.void, clear: () => Effect.void }),
}));
vi.mock("../src/usage/collect.ts", () => ({
  usageCollector: (api: typeof control.usageApi) =>
    Effect.sync(() => {
      control.usageApi = api;
      return { tick: Effect.void, session: () => step("usage.snapshot") };
    }),
}));
vi.mock("../src/opencode/application-gateway.ts", () => ({
  applicationGateway: () => ({
    handler: control.callback,
    dispose: async () => {
      control.events.push("callback.close");
    },
  }),
}));
vi.mock("../src/operator/api.ts", () => ({
  operatorHandler: () => ({
    handler: control.operator,
    dispose: async () => {
      control.events.push("operator.close");
    },
  }),
}));
vi.mock("../src/opencode/remote.ts", () => ({
  remoteHost: (config: RemoteConfig) =>
    Effect.gen(function* () {
      control.onPrompt.mockImplementation(config.onPrompt!);
      yield* Effect.addFinalizer(() => step("remote.close"));
      yield* Effect.promise(() => control.startup());
      yield* step("remote");
      return {
        client: {
          session: { active: control.activeRead },
          message: { list: () => Effect.fail(new Error("upstream usage failed")) },
        },
        sessions: {
          get: () => Effect.succeed(fromPartial<Session.Info>({ id: "ses_usage" })),
          remove: () => step("session.remove"),
        },
      };
    }),
}));
vi.mock("../src/opencode/catalog-sync.ts", () => ({
  syncFolders: () => step("folders"),
  catalogRefresher: () => ({ refresh: () => step("refresh"), reconcile: () => step("reconcile") }),
}));
vi.mock("../src/discovery/first-contact.ts", () => ({
  firstContacts: () => Effect.succeed({ tick: step("contacts") }),
}));
vi.mock("../src/conversations/runtime-status.ts", () => ({
  runtimeStatus: (_host: object, active: (id: Session.ID) => Effect.Effect<boolean, Error>) =>
    Effect.sync(() => {
      control.activeProbe.mockImplementation(active);
      return {};
    }),
  runtimeStatusRequest:
    (_service: object, run: (effect: Effect.Effect<void>) => Promise<void>) => async () => {
      await run(Effect.void);
      return new Response("conversation-status");
    },
}));
vi.mock("../src/discovery/conversation-languages.ts", () => ({
  conversationLanguages:
    (read: (id: string) => Effect.Effect<typeof folderSnapshot.Type, Error>) => () =>
      read("ses_languages").pipe(
        Effect.match({
          onSuccess: () => new Response("languages"),
          onFailure: (cause) => {
            control.languageFailure = cause;
            return new Response("unavailable", { status: 503 });
          },
        }),
      ),
}));
vi.mock("../src/application.ts", () => ({
  startMessagingApplication: (
    _personas: Map<string, never>,
    create: (
      tools: object,
    ) => Effect.Effect<{ sessions: { remove: (id: Session.ID) => Effect.Effect<void, Error> } }>,
  ) =>
    create({}).pipe(
      Effect.tap((host) =>
        Effect.sync(() => {
          control.removeSession = host.sessions.remove;
        }),
      ),
      Effect.map(() => ({
        client: {
          rpc: () => ({ read: control.folderRead }),
          session: { active: control.activeRead },
        },
        operator: {},
        conversations: {},
        heartbeat: {
          endings: step("endings"),
          stopped: step("stopped"),
          intake: step("intake"),
          followUps: step("followUps"),
          failedTurns: step("failedTurns"),
          checkTurns: () => step("checkTurns"),
          rebuilds: step("rebuilds"),
        },
      })),
    ),
}));
vi.mock("../src/application-tools.ts", () => ({
  prepareMessaging: () => Effect.succeed({ endings: {} }),
}));
