import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { discoveryNotice, ContactSelection } from "@ren-ai/onboarding";
import {
  fakeGestures,
  fakeMessages,
  fakeNotifications,
  messageGateway,
} from "@ren-ai/imsg/testing";
import { servePublic } from "@ren-ai/transport/listener";
import { createGateway } from "../../api-msg/src/gateway.ts";
import { messagingFixture } from "../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../test/messaging-host.test-helper.ts";
import { registerApplicationPlugin } from "../test/server.test-helper.ts";
import { remotePersonaPlugins } from "../test/persona-plugins.test-helper.ts";
import { listenerUrl } from "../test/listener.test-helper.ts";
import { executionState, executionWorker } from "../test/execution-worker.ts";
import type { Miniflare } from "miniflare";
import { locateBinding, readSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import { readState } from "../../../packages/plugins/session-folder/src/memory-markdown.ts";
import { emptyMemory, restoreMemory } from "../test/memory.test-helper.ts";
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
                sendText: (handle, text, attemptID) => {
                  attempts++;
                  return outcome === "uncertain"
                    ? fake
                        .outgoing(handle, text, Date.now(), "unknown", attemptID)
                        .pipe(
                          Effect.andThen(
                            Effect.fail(new Error("Connection lost; send outcome unknown")),
                          ),
                        )
                    : fake.messages.sendText(handle, text, attemptID);
                },
              },
              "imsg-secret",
              fakeGestures().gestures,
              fakeNotifications(),
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
              const registration = {
                handle: "+821012345678",
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                turnstileToken: "human",
                likedPersonaIDs: ["persona1"],
              };
              const registered = await send("/discovery/waitlist", registration);
              expect(await registered.json()).toEqual({ status: "waiting" });
              expect(registered.status).toBe(200);
              // The automatic Notification alarm must finish its availability lookup
              // before this fixture seeds a completed result for offline Selection.
              await expect
                .poll(async () => (await executionState(runtime!)).notifications, {
                  timeout: 10_000,
                })
                .toEqual([{ state: "uncertain" }]);
              await executionState(runtime, "/__fixture/verify-imessage");
              const select = { requestId: "00000000-0000-4000-8000-000000000028", count: 1 };
              const selected = await send("/management/discovery/select", select);
              expect(selected.status).toBe(200);
              const selection = Schema.decodeUnknownSync(ContactSelection)(await selected.json());
              expect(selection.entries).toHaveLength(1);
              expect(selection).toMatchObject({
                requestId: select.requestId,
                requested: 1,
              });
              // Registration and selection completed while execution was unavailable.
              expect(attempts).toBe(0);
              const offline = await executionState(runtime, "/__fixture/alarm");
              // Messaging gets its own 20-second recheck while startup backs off.
              expect(offline.alarm).toBeGreaterThan(Date.now() + 15_000);
              expect((await runtime.dispatchFetch("https://app/discovery/personas")).status).toBe(
                200,
              );
              available = true;
              await executionState(runtime, "/__fixture/due");
              await executionState(runtime, "/__fixture/alarm");
              expect(startupCallbacks).toBe(1);
              const bubbles =
                outcome === "sent"
                  ? [{ handle: "+821012345678", text: "안녕, 실제 네이티브 인사야 🙂" }]
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
              // The real Cloudflare SQLite limit is 100 bindings, unlike Node SQLite.
              for (const count of [0, 99, 100, 205]) {
                const context = await Effect.runPromise(
                  callback.context({
                    sessionID: creates[0]!,
                    messageIDs: Array.from({ length: count }, (_, i) => `msg_context_${i}`),
                  }),
                );
                expect(context.sends).toEqual([]);
              }
              const located = (await locateBinding(personaDirectory, creates[0]!))!;
              expect(located).toMatchObject({ personaID: "persona1", sandbox: false });
              const session = located.directory;
              const binding = await readSessionBinding(session, creates[0]!);
              expect(binding.conversationKey).toBe(located.conversationKey);
              const relationship = join(session, "conversations", binding.conversationKey);
              const files = async () => ({
                state: await readFile(join(session, "STATE.md"), "utf8"),
                memory: await readFile(join(session, "MEMORY.md"), "utf8"),
                relationshipState: await readFile(join(relationship, "STATE.md"), "utf8"),
                relationshipMemory: await readFile(join(relationship, "MEMORY.md"), "utf8"),
              });
              const initialized = await files();
              expect(readState(initialized.state).state).toMatchObject({ mood: 50 });
              expect(readState(initialized.state).state).not.toHaveProperty("affection");
              expect(initialized.memory).toContain("initial Memory");
              expect(readState(initialized.relationshipState).state).toEqual({ affection: 50 });
              expect(initialized.relationshipMemory.trim()).toBe("");
              await restoreMemory(relationship, {
                ...emptyMemory,
                state: { affection: 73 },
                shortTerm: "This user prefers evening messages.",
              });
              const initial = await files();
              expect(readState(initial.relationshipState).state).toEqual({ affection: 73 });
              expect(initial.relationshipMemory).toContain("This user prefers evening messages.");
              expect(initial.memory).toBe(initialized.memory);
              expect(initial.state).toBe(initialized.state);
              const languageUrl = `https://app/operator/languages?registrationID=${selection.entries[0]!.id}`;
              expect((await runtime.dispatchFetch(languageUrl)).status).toBe(401);
              const languageResponse = await runtime.dispatchFetch(languageUrl, {
                headers: { authorization: "Bearer management-secret" },
              });
              expect(languageResponse.status).toBe(200);
              expect(await languageResponse.json()).toEqual({});
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
              expect((await send("/discovery/waitlist", registration)).status).toBe(200);
              await expect
                .poll(async () => (await executionState(runtime!)).notifications)
                .toEqual([{ state: "uncertain" }, { state: "sent" }]);
              const replay = await (await send("/management/discovery/select", select)).json();
              await runtime.dispose();
              runtime = await executionWorker(persistence, listenerUrl(mac), personaDirectory);
              expect(await (await send("/management/discovery/select", select)).json()).toEqual(
                replay,
              );
              await executionState(runtime, "/__fixture/alarm");
              expect((await executionState(runtime)).conversations).toEqual(state.conversations);
              expect((await executionState(runtime)).sends).toEqual(state.sends);
              expect((await executionState(runtime)).notifications).toEqual([
                { state: "uncertain" },
                { state: "sent" },
              ]);
              expect((await executionState(runtime)).catalogReads).toBe(0);
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
