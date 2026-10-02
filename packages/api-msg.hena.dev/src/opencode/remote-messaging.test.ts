import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { startMessagingApplication } from "../application.ts";
import { applicationGateway } from "./application-gateway.ts";
import { remotePersonaPlugin } from "./remote-plugin.ts";
import { remoteHost } from "./remote.ts";
import { remoteMessages } from "../gateway/client.ts";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import {
  messagingFixture,
  registration,
  runMessagingTest,
  silentAlerts,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { intruder } from "../../test/host.test-helper.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";
import {
  unrelatedSession,
  registerApplicationPlugin,
  allowAllSessionTools,
} from "../../test/server.test-helper.ts";

const unavailable = (_request: Request) =>
  Promise.resolve(new Response("starting", { status: 503 }));

test("an incoming message reaches Docker's persona plugin and replies through the authorized Mac API", async () => {
  const { root, personaDirectory } = await messagingFixture("distributed-messaging-");
  const mac = gatewayFixture();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        const waiting = yield* Deferred.make<void>();
        let step = 0;
        yield* llm.serve(() => {
          step++;
          if (step === 1) return TestLLM.tool("mark", "read", {});
          if (step === 2) return TestLLM.tool("reaction", "react", { tapback: "love" });
          if (step === 3) return TestLLM.tool("pause", "wait", { minutes: 1 });
          if (step === 4) return TestLLM.tool("reply", "send", { text: "hello from Docker" });
          return TestLLM.text("done", "answer");
        });
        const native = yield* standaloneTestHost(root, personaDirectory, llm);
        yield* Effect.promise(() => native.run(native.plugins.register(intruder)));
        const alerts: string[] = [];
        let alertRequests = 0;
        let disconnected = false;
        let applicationWeb = unavailable;
        const network: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const hostname = new URL(request.url).hostname;
          const waitingRequest =
            hostname === "app.test" && (await request.clone().text()).includes('"tag":"wait"');
          if (hostname === "app.test" && disconnected)
            return new Response("offline", { status: 503 });
          if (
            hostname === "app.test" &&
            (await request.clone().text()).includes('"tag":"alert"') &&
            alertRequests++ > 0
          )
            return new Response("diagnostics unavailable", { status: 503 });
          const response = await (hostname === "oc.test"
            ? native.web(request)
            : hostname === "imsg.test"
              ? mac.server.handler(request)
              : applicationWeb(request));
          if (waitingRequest) Effect.runSync(Deferred.succeed(waiting, undefined));
          return response;
        };
        const application = yield* Effect.gen(function* () {
          const messages = yield* remoteMessages({ url: "https://imsg.test/rpc", token: "secret" });
          return yield* startMessagingApplication(
            native.personas,
            (tools) =>
              Effect.gen(function* () {
                const api = applicationGateway(
                  tools,
                  {
                    ...silentAlerts,
                    raise: (name, detail) =>
                      Effect.sync(() => {
                        alerts.push(`${name}: ${detail}`);
                      }),
                  },
                  "application-secret",
                );
                applicationWeb = api.handler;
                yield* Effect.addFinalizer(() => Effect.promise(api.dispose));
                const plugin = remotePersonaPlugin({
                  url: "https://app.test/rpc",
                  token: "application-secret",
                  directory: personaDirectory,
                });
                yield* registerApplicationPlugin(native, plugin, network);
                return yield* remoteHost(
                  {
                    baseUrl: "https://oc.test",
                    authorization: "Basic test",
                    directory: personaDirectory,
                    model: "test/probe",
                  },
                  native.personas,
                );
              }),
            messages,
            messages.gestures,
            { notice: noticeCopy, turnstileSecret: "test" },
            silentAlerts,
          );
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, network),
        );
        const session = yield* application.createSession("persona1");
        yield* application.conversations.create(registration("+821012345678", session.id));
        mac.local.status("+821012345678", {
          delivered: true,
          readAt: Date.parse("2026-09-25T12:04:00Z"),
        });
        yield* allowAllSessionTools(application, session.id);
        yield* mac.local.text("+821012345678", "hello", Date.now());
        yield* Deferred.await(waiting).pipe(Effect.timeout("3 seconds"));
        yield* Effect.sleep("20 millis");
        yield* mac.local.text("+821012345678", "wake the wait", Date.now());
        yield* Effect.gen(function* () {
          while (!mac.local.bubbles.length) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds"));
        yield* application.sessions.wait(session.id);
        const modelRequests = yield* llm.requests();
        expect(JSON.stringify(modelRequests[0])).toContain("read 21:04");
        const pauseResults = modelRequests
          .flatMap((request) => request.messages)
          .flatMap((message) => message.content)
          .filter((part) => part.type === "tool-result")
          .filter((part) => part.id === "pause")
          .map((part) => part.result);
        expect(
          pauseResults.some(
            (result) =>
              result.type === "text" &&
              typeof result.value === "string" &&
              /^paused \d+s, cut short by something new$/.test(result.value),
          ),
        ).toBe(true);
        expect(mac.local.bubbles).toEqual([{ handle: "+821012345678", text: "hello from Docker" }]);
        expect(mac.gestures.reads).toEqual(["+821012345678"]);
        expect(mac.gestures.reactions).toEqual([{ handle: "+821012345678", tapback: "love" }]);
        expect(alerts[0]).toMatch(/^unexpected-tool: OpenCode offered disallowed tool:/);
        expect(alertRequests).toBeGreaterThan(1);
        expect((yield* application.sessions.get(session.id)).title).toBe(
          "Persona1 · +821012345678",
        );
        expect((yield* llm.requests())[0]!.tools.map((tool) => tool.name).toSorted()).toEqual([
          "react",
          "read",
          "send",
          "wait",
        ]);
        let orphanAttempt = false;
        yield* llm.serve((request) => {
          if (request.tools.some((tool) => tool.name === "send") && !orphanAttempt) {
            orphanAttempt = true;
            return TestLLM.tool("orphan", "send", { text: "must not escape" });
          }
          return TestLLM.text("stopped", "answer");
        });
        const orphan = yield* application.createSession("persona1");
        yield* application.sessions.prompt({ sessionID: orphan.id, text: "an unbound session" });
        yield* application.sessions.wait(orphan.id);
        expect(
          JSON.stringify(yield* application.sessions.messages({ sessionID: orphan.id })),
        ).toContain("No Conversation for session");
        expect(mac.local.bubbles).toHaveLength(1);
        disconnected = true;
        const otherDirectory = join(root, "other-project");
        yield* Effect.promise(() => mkdir(otherDirectory));
        expect((yield* unrelatedSession(application.client, otherDirectory)).outcome).toBe(
          "succeeded",
        );
        const plugins = yield* application.client.plugin.list({
          location: { directory: otherDirectory },
        });
        expect(plugins.data.find((plugin) => plugin.id === "personas")?.state.status).toBe(
          "active",
        );
        yield* Effect.promise(application.disposeOnboarding);
      }),
    );
  } finally {
    await mac.server.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
