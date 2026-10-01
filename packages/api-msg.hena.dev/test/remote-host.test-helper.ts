import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, type Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { TestLLM } from "@opencode/ai/testing";
import { startPersonaHost } from "./application.test-helper.ts";
import { messagingFixture, scriptedPersona } from "./messaging-host.test-helper.ts";
import { scriptedOverrides } from "./host.test-helper.ts";
import { remoteHost } from "../src/opencode/remote.ts";
import { silentAlerts } from "../src/opencode/scripted-overrides.test-helper.ts";
import type { Message } from "@opencode/ai";
import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import type { SessionImportInput } from "@opencode/client/effect/api";
import { exportSessions, restoreSessions } from "../src/opencode/transfer.ts";
import { sessionArchive } from "../src/opencode/transfer-format.ts";
import { expect } from "vitest";

type Remote = Effect.Success<ReturnType<typeof remoteHost>>;
type Native = Effect.Success<ReturnType<typeof startPersonaHost>>;

export const withRemoteHost = async <A, E>(
  story: (
    remote: Remote,
    directory: string,
    boundary: {
      readonly llm: TestLLM.TestInterface;
      readonly registerPlugin: (
        plugin: Parameters<Native["plugins"]["register"]>[0],
      ) => Effect.Effect<void, Error>;
      readonly transport: {
        readonly requests: Array<Request>;
        fetch: (request: Request) => Promise<Response>;
      };
    },
  ) => Effect.Effect<A, E, Scope.Scope>,
) => {
  const { root, personaDirectory } = await messagingFixture("remote-transfer-");
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() => TestLLM.text("preserved memory", "answer"));
          const native = yield* startPersonaHost(join(root, "isolated"), {
            configDirectory: join(root, "config"),
            databasePath: ":memory:",
            personaDirectory,
            providers: {},
            model: "test/probe",
            handleForSession: () => Effect.succeed(undefined),
            health: silentAlerts,
            overrides: scriptedOverrides(llm),
          });
          const requests: Array<Request> = [];
          const transport = {
            requests,
            fetch: (request: Request) => {
              requests.push(request.clone());
              return native.web(request);
            },
          };
          const remote = yield* remoteHost(
            {
              baseUrl: "https://oc.test",
              authorization: "Basic test",
              directory: personaDirectory,
              model: "test/probe",
            },
            native.personas,
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
              transport.fetch(new Request(input, init)),
            ),
          );
          const registerPlugin = (plugin: Parameters<Native["plugins"]["register"]>[0]) =>
            Effect.tryPromise({
              try: () => native.run(native.plugins.register(plugin)),
              catch: (error) => new Error(String(error)),
            });
          return yield* story(remote, personaDirectory, { llm, transport, registerPlugin });
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const awaitRemote = (ready: () => boolean) =>
  Effect.gen(function* () {
    while (!ready()) yield* Effect.sleep("10 millis");
  }).pipe(Effect.timeout("3 seconds"));

export const requestText = (messages: ReadonlyArray<Message>) =>
  messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

export const exportedSession = (remote: Remote, id: Session.ID) =>
  exportSessions(remote.client, [id]).pipe(
    Effect.map((contents) => Schema.decodeUnknownSync(sessionArchive)(contents).sessions[0]!),
  );

export const pausedRestore = (
  remote: Remote,
  llm: TestLLM.TestInterface,
  contents: string,
  directory: string,
) =>
  Effect.gen(function* () {
    const gate = yield* llm.gate();
    const before = yield* llm.requests();
    yield* restoreSessions(remote.client, contents, directory);
    const entry = Schema.decodeUnknownSync(sessionArchive)(contents).sessions[0]!;
    yield* remote.sessions.wait(entry.info.id).pipe(
      Effect.timeout("200 millis"),
      Effect.onExit(() => gate.release),
    );
    expect(yield* llm.requests()).toEqual(before);
  });

export const replaceCheckpoint = (remote: Remote, input: SessionImportInput) =>
  Effect.gen(function* () {
    yield* remote.sessions.remove(input.info.id);
    return yield* remote.client.session.import(input);
  });

export const promotedCheckpoint = (remote: Remote, id: SessionMessage.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* remote.createSession("persona1");
    const promoted = SessionMessage.User.make({
      id,
      text,
      time: { created: session.time.created },
    });
    yield* replaceCheckpoint(remote, { info: session, messages: [promoted] });
    return { session, promoted };
  });
