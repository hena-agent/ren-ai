import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { discoveryNotice } from "@ren-ai/onboarding";
import { fakeGestures, fakeMessages, messageGateway } from "@ren-ai/imsg/testing";
import { servePublic } from "@ren-ai/transport/listener";
import { createGateway } from "../../api-msg/src/gateway.ts";
import { messagingFixture } from "../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../test/messaging-host.test-helper.ts";
import { registerApplicationPlugin } from "../test/server.test-helper.ts";
import { remotePersonaPlugins } from "../test/persona-plugins.test-helper.ts";
import { listenerUrl } from "../test/listener.test-helper.ts";
import { executionState, executionWorker } from "../test/execution-worker.ts";
import type { Miniflare } from "miniflare";
import { parseInitialState } from "@ren-ai/personas";
import { rpcClient } from "@ren-ai/transport/client";
import { applicationApi } from "./opencode/application-protocol.ts";
import { FetchHttpClient } from "effect/unstable/http";

test.each(["sent", "uncertain"] as const)(
  "compiled SQLite DO alarm preserves native %s first contact across restart without resend or document reset",
  async (outcome) => {
    const { root, personaDirectory } = await messagingFixture("native-execution-");
    const persistence = await mkdtemp(join(tmpdir(), "execution-do-"));
    let runtime: Miniflare | undefined;
    const callbackNetwork: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname !== "app") throw new Error("Unexpected plugin upstream");
      if (!runtime) throw new Error("Worker unavailable");
      const response = await runtime.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    };
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const llm = yield* scriptedPersona();
            const fake = fakeMessages();
            let attempts = 0;
            let available = false;
            let greeted = false;
            yield* llm.serve((request) => {
              if (!request.tools.some((tool) => tool.name === "send"))
                return TestLLM.text("title", "title");
              if (!greeted) {
                greeted = true;
                return TestLLM.tool("native-greeting", "send", {
                  text: "안녕, 실제 네이티브 인사야 🙂",
                });
              }
              return TestLLM.text("done", "answer");
            });
            const native = yield* standaloneTestHost(root, personaDirectory, llm);
            const callback = yield* rpcClient(applicationApi, {
              url: "https://app/rpc",
              token: "management-secret",
            }).pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.provideService(FetchHttpClient.Fetch, callbackNetwork),
            );
            let startupCallbacks = 0;
            yield* registerApplicationPlugin(
              native,
              remotePersonaPlugins({
                url: "https://app/rpc",
                token: "management-secret",
                directory: personaDirectory,
              }),
              callbackNetwork,
            );
            const creates: string[] = [];
            const openCode = yield* servePublic(async (request) => {
              expect(request.headers.get("authorization")).toBe("Basic native-secret");
              if (startupCallbacks === 0 && new URL(request.url).pathname === "/api/session") {
                startupCallbacks++;
                // Native startup must be able to await the application, not its own readiness.
                const catalog = await Effect.runPromise(
                  callback.catalog().pipe(Effect.timeout("2 seconds")),
                );
                expect(catalog.map((persona) => persona.id)).toEqual(["persona1"]);
              }
              const body = request.method === "POST" ? await request.clone().text() : "";
              if (
                body.includes('"folderID"') &&
                body.includes('"snapshot"') &&
                body.includes('"model"')
              ) {
                if (!runtime) throw new Error("Missing Worker");
                const state = await executionState(runtime);
                expect(state.contacts[0]?.state).toBe("preparing");
                expect(typeof state.contacts[0]?.session_id).toBe("string");
                creates.push(state.contacts[0]!.session_id!);
              }
              return native.web(request);
            }, 0);
            const messages = messageGateway(
              {
                ...fake.messages,
                sendText: (handle, text) => {
                  attempts++;
                  return outcome === "uncertain"
                    ? Effect.fail(new Error("Connection lost; send outcome unknown"))
                    : fake.messages.sendText(handle, text);
                },
              },
              "imsg-secret",
              fakeGestures().gestures,
            );
            yield* Effect.addFinalizer(() => Effect.promise(messages.dispose));
            const imsg = yield* servePublic(messages.handler, 0);
            const gateway = createGateway({
              config: {
                managementToken: "management-secret",
                opencodeUrl: listenerUrl(openCode),
                opencodeAuthorization: "Basic native-secret",
                imsgUrl: `${listenerUrl(imsg)}/rpc`,
                imsgToken: "imsg-secret",
              },
              health: async () => ({ diskNearlyFull: false, screenLocked: false }),
              log: () => {},
            });
            const mac = yield* servePublic(
              (request) =>
                available
                  ? gateway(request)
                  : Promise.resolve(new Response("Mac down", { status: 503 })),
              0,
            );
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                await runtime?.dispose();
                runtime = undefined;
              }),
            );
            yield* Effect.promise(async () => {
              runtime = await executionWorker(persistence, listenerUrl(mac), personaDirectory);
              const send = (path: string, body: object) =>
                runtime!.dispatchFetch(`https://app${path}`, {
                  method: "POST",
                  headers: {
                    authorization: "Bearer management-secret",
                    "content-type": "application/json",
                    "CF-Connecting-IP": "127.0.0.1",
                  },
                  body: JSON.stringify(body),
                });
              const registered = await send("/discovery/waitlist", {
                handle: "native@example.com",
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                turnstileToken: "human",
                likedPersonaIDs: ["persona1"],
              });
              expect(await registered.json()).toEqual({ status: "waiting" });
              expect(registered.status).toBe(200);
              const select = { requestId: "00000000-0000-4000-8000-000000000028", count: 1 };
              const selected = await send("/management/discovery/select", select);
              expect(selected.status).toBe(200);
              expect(await selected.json()).toMatchObject({
                requestId: select.requestId,
                requested: 1,
              });
              // Registration and selection completed while execution was unavailable.
              expect(attempts).toBe(0);
              await expect(executionState(runtime, "/__fixture/alarm")).rejects.toThrow(
                "Application is unavailable",
              );
              expect((await runtime.dispatchFetch("https://app/discovery/personas")).status).toBe(
                200,
              );
              available = true;
              await executionState(runtime, "/__fixture/due");
              await executionState(runtime, "/__fixture/alarm");
              expect(startupCallbacks).toBe(1);
              const bubbles =
                outcome === "sent"
                  ? [{ handle: "native@example.com", text: "안녕, 실제 네이티브 인사야 🙂" }]
                  : [];
              await expect
                .poll(async () => (await executionState(runtime!)).sends[0]?.state, {
                  timeout: 10_000,
                })
                .toBe(outcome);
              expect(fake.bubbles).toEqual(bubbles);
              await expect
                .poll(
                  async () =>
                    (await executionState(runtime!, "/__fixture/alarm")).contacts[0]?.state,
                )
                .toBe(outcome === "sent" ? "active" : "review");
              const state = await executionState(runtime);
              expect(creates).toEqual([state.conversations[0]!.session_id]);
              expect(state.sends).toEqual([{ state: outcome, tool_call_id: "native-greeting" }]);
              const session = join(personaDirectory, "sessions", creates[0]!);
              const files = async () => ({
                state: await readFile(join(session, "STATE.md"), "utf8"),
                memory: await readFile(join(session, "MEMORY.md"), "utf8"),
              });
              const initial = await files();
              expect(parseInitialState(initial.state).mood).toBe(50);
              expect(initial.memory).toContain("initial Memory");
              await executionState(runtime, "/__fixture/catalog");
              const idle = await executionState(runtime, "/__fixture/alarm");
              expect(idle.catalogReads).toBe(state.catalogReads);
              const agent = join(session, ".opencode/agents/persona1.md");
              expect(await readFile(agent, "utf8")).not.toContain(
                "Updated character instructions.",
              );
              expect((await send("/management/catalog/refresh", {})).status).toBe(204);
              expect((await executionState(runtime)).catalogReads).toBe(state.catalogReads + 1);
              expect(await readFile(agent, "utf8")).toContain("Updated character instructions.");
              expect(await files()).toEqual(initial);
              const replay = await (await send("/management/discovery/select", select)).json();
              await runtime.dispose();
              runtime = await executionWorker(persistence, listenerUrl(mac), personaDirectory);
              expect(await (await send("/management/discovery/select", select)).json()).toEqual(
                replay,
              );
              await executionState(runtime, "/__fixture/alarm");
              expect((await executionState(runtime)).conversations).toEqual(state.conversations);
              expect(creates).toHaveLength(1);
              expect(attempts).toBe(1);
              expect(fake.bubbles).toEqual(bubbles);
              expect((await executionState(runtime)).contacts[0]?.state).toBe(
                outcome === "sent" ? "active" : "review",
              );
              expect(await files()).toEqual(initial);
            });
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      );
    } finally {
      await runtime?.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(persistence, { recursive: true, force: true });
    }
  },
  60_000,
);
