import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { conversationTools } from "../../test/host.test-helper.ts";
import { startMessagingApplication } from "../application.ts";
import { applicationGateway } from "./application-gateway.ts";
import { remotePersonaPlugins } from "../../test/persona-plugins.test-helper.ts";
import { remoteHost } from "./remote.ts";
import { remoteMessages } from "@ren-ai/imsg/client";
import {
  fakeGestures,
  fakeMessages,
  fakeNotifications,
  messageGateway,
} from "@ren-ai/imsg/testing";
import {
  messagingFixture,
  registration,
  runMessagingTest,
  silentAlerts,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { intruder } from "../../test/host.test-helper.ts";
import {
  unrelatedSession,
  registerApplicationPlugin,
  allowAllSessionTools,
} from "../../test/server.test-helper.ts";

const unavailable = (_request: Request) =>
  Promise.resolve(new Response("starting", { status: 503 }));

test("an incoming message reaches Docker's persona plugin and replies through the authorized Mac API", async () => {
  const { root, personaDirectory } = await messagingFixture("distributed-messaging-");
  const local = fakeMessages();
  const gestures = fakeGestures();
  const notices: string[] = [];
  const mac = messageGateway(local.messages, "secret", gestures.gestures, {
    ...fakeNotifications(),
    sendText: (_handle, text) =>
      Effect.sync(() => {
        notices.push(text);
        return { guid: "ending-notice-guid" };
      }),
  });
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
          if (step === 3) {
            Effect.runSync(Deferred.succeed(waiting, undefined));
            return TestLLM.tool("pause", "wait", { seconds: 60 });
          }
          if (step === 4)
            return TestLLM.tool("reply", "send", { messages: [{ text: "hello from Docker" }] });
          return TestLLM.text("done", "answer");
        });
        const native = yield* standaloneTestHost(root, personaDirectory, llm);
        yield* Effect.promise(() => native.run(native.plugins.register(intruder)));
        const alerts: string[] = [];
        let alertRequests = 0;
        let observations = 0;
        let disconnected = false;
        let applicationWeb = unavailable;
        const network: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const hostname = new URL(request.url).hostname;
          if (hostname === "app.test" && (await request.clone().text()).includes('"tag":"observe"'))
            observations++;
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
              ? mac.handler(request)
              : applicationWeb(request));
          return response;
        };
        const application = yield* Effect.gen(function* () {
          const messages = yield* remoteMessages({
            url: "https://imsg.test/rpc",
            token: "secret",
          });
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
                const plugin = remotePersonaPlugins({
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
                    groundRules: "",
                  },
                  native.personas,
                );
              }),
            messages,
            messages.gestures,
            silentAlerts,
            false,
          );
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, network),
        );
        const stopHeartbeat = yield* local.messages.follow(0, () =>
          Effect.all([application.heartbeat.intake, application.heartbeat.followUps]),
        );
        yield* application.heartbeat.intake;
        yield* Effect.addFinalizer(() => Effect.sync(stopHeartbeat));
        const session = yield* application.createSession("persona1");
        yield* application.conversations.create(registration("+821012345678", session.id));
        local.status("+821012345678", {
          delivered: true,
          readAt: Date.parse("2026-09-25T12:04:00Z"),
        });
        yield* allowAllSessionTools(application, session.id);
        yield* local.text("+821012345678", "hello", Date.now());
        yield* Deferred.await(waiting).pipe(Effect.timeout("3 seconds"));
        yield* Effect.sleep("20 millis");
        yield* local.text("+821012345678", "wake the wait", Date.now());
        yield* Effect.gen(function* () {
          while (!local.bubbles.length) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("5 seconds"));
        yield* application.sessions.wait(session.id);
        yield* Effect.promise(async () => {
          await expect.poll(() => observations).toBeGreaterThan(0);
        });
        yield* application.heartbeat.checkTurns([session.id]);
        yield* application.heartbeat.rebuilds;
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
        expect(local.bubbles).toEqual([{ handle: "+821012345678", text: "hello from Docker" }]);
        expect(gestures.reads).toEqual(["+821012345678"]);
        expect(gestures.reactions).toEqual([{ handle: "+821012345678", tapback: "love" }]);
        expect(alerts[0]).toMatch(/^unexpected-tool: OpenCode offered disallowed tool:/);
        expect(alertRequests).toBeGreaterThan(1);
        expect((yield* application.sessions.get(session.id)).title).toBe(
          "Persona1 · +821012345678",
        );
        expect((yield* llm.requests())[0]!.tools.map((tool) => tool.name).toSorted()).toEqual(
          conversationTools([
            "dice",
            "end_conversation",
            "react",
            "read",
            "send",
            "wait",
          ]).toSorted(),
        );
        let orphanAttempt = false;
        yield* llm.serve((request) => {
          if (request.tools.some((tool) => tool.name === "send") && !orphanAttempt) {
            orphanAttempt = true;
            return TestLLM.tool("orphan", "send", { messages: [{ text: "must not escape" }] });
          }
          return TestLLM.text("stopped", "answer");
        });
        const orphan = yield* application.createSession("persona1");
        yield* application.sessions.prompt({
          sessionID: orphan.id,
          text: "an unbound session",
        });
        yield* application.sessions.wait(orphan.id);
        expect(
          JSON.stringify(yield* application.sessions.messages({ sessionID: orphan.id })),
        ).toContain("No Conversation for session");
        expect(local.bubbles).toHaveLength(1);
        let ended = false;
        yield* llm.serve(() => {
          if (!ended) {
            ended = true;
            return TestLLM.tool("end-remote", "end_conversation", {
              farewell: "이제 대화를 끝낼게요.",
            });
          }
          return TestLLM.text("stopped", "answer");
        });
        yield* application.sessions.prompt({
          sessionID: session.id,
          text: "end this relationship",
        });
        yield* application.sessions.wait(session.id);
        expect(yield* application.conversations.byHandle("+821012345678")).toBeUndefined();
        yield* application.heartbeat.endings;
        expect(local.bubbles).toHaveLength(2);
        expect(local.bubbles[1]?.text).toBe("이제 대화를 끝낼게요.");
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("#reselect=");
        disconnected = true;
        const otherDirectory = join(root, "other-project");
        yield* Effect.promise(() => mkdir(otherDirectory));
        expect((yield* unrelatedSession(application.client, otherDirectory)).outcome).toBe(
          "succeeded",
        );
        const plugins = yield* application.client.plugin.list({
          location: { directory: otherDirectory },
        });
        for (const id of ["tools", "context", "memory", "title", "dice"]) {
          expect(plugins.data.find((plugin) => plugin.id === `ren-ai.${id}`)?.state.status).toBe(
            "active",
          );
        }
      }),
    );
  } finally {
    await mac.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
