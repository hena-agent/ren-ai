import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Session } from "@opencode/schema/session";
import { expect, test, vi } from "vitest";
import { fakeMessages, fakeGestures } from "@ren-ai/imsg/testing";
import { discoveryNotice, ContactSelection } from "@ren-ai/onboarding";
import { SqlClient } from "effect/unstable/sql";
import { randomUUID } from "node:crypto";
import { runOperatorCli } from "./operator/cli.ts";
import { exportSessions } from "./opencode/transfer.ts";
import { valid, personaFixture } from "../test/host.test-helper.ts";
import { composedTestServer, unrelatedSession } from "../test/server.test-helper.ts";
import { listenerUrl } from "../test/listener.test-helper.ts";
import { servePublic } from "@ren-ai/transport/listener";
import { runMessagingTest } from "../test/messaging.test-helper.ts";
import { checkAvailability } from "./discovery/availability.ts";

const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

test("composed HTTP, remote OpenCode, messaging API and authenticated operator complete a Conversation", async () => {
  const { root, personaDirectory, cleanup } = await personaFixture("composed-server-", valid);
  const fake = fakeMessages();
  const ui = fakeGestures();
  let greeted = false;
  let replied = false;
  const network = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes("siteverify") || url.includes("discord.invalid")
      ? Promise.resolve(Response.json({ success: true }))
      : network(input, init);
  });
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
        yield* llm.serve((request) => {
          if (!request.tools.some((tool) => tool.name === "send"))
            return TestLLM.text("title", "title");
          if (JSON.stringify(request.messages).includes("안녕?")) {
            if (!replied) {
              replied = true;
              return TestLLM.tool("call-2", "send", { text: "반가워!" });
            }
          } else if (!greeted) {
            greeted = true;
            return TestLLM.tool("call-1", "send", { text: "안녕 🙂" });
          }
          return TestLLM.text("done", "done");
        });
        const server = yield* composedTestServer(
          root,
          personaDirectory,
          llm,
          fake.messages,
          ui.gestures,
          "test/probe",
        );
        const sql = yield* SqlClient.SqlClient;
        const registration = yield* Effect.promise(() =>
          server.publicWeb(
            new Request("http://local/discovery/waitlist", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "https://renai.im",
              },
              body: JSON.stringify({
                handle: "+821012345678",
                likedPersonaIDs: ["persona1"],
                locale: "ko",
                privacyNoticeVersion: discoveryNotice.version,
                turnstileToken: "human",
              }),
            }),
          ),
        );
        expect(registration.status).toBe(200);
        expect(registration.headers.get("access-control-allow-origin")).toBe("https://renai.im");
        const [waiting] = yield* sql<{ id: string }>`SELECT id FROM discovery_registration`;
        yield* checkAvailability(
          waiting!.id,
          {
            availability: (handle) =>
              fake.messages
                .availability(handle)
                .pipe(Effect.map((result) => ({ ...result, requestId: randomUUID() }))),
          },
          () => {},
        );
        const key = randomUUID();
        const selected = yield* Effect.promise(() =>
          server.publicWeb(
            new Request("http://local/management/discovery/select", {
              method: "POST",
              headers: { Authorization: "Bearer management-test-token" },
              body: JSON.stringify({ requestId: key, count: 1 }),
            }),
          ),
        );
        expect(selected.status).toBe(200);
        const selection = Schema.decodeUnknownSync(ContactSelection)(
          yield* Effect.promise(() => selected.json()),
        );
        expect(selection.requestId).toBe(key);
        expect(selection.entries).toHaveLength(1);
        yield* sql`UPDATE discovery_contact SET scheduled_at = 0`;
        const waitForBubbles = (count: number) =>
          Effect.gen(function* () {
            while (fake.bubbles.length < count) yield* Effect.sleep("20 millis");
            expect(fake.bubbles).toHaveLength(count);
          }).pipe(Effect.timeout("5 seconds"));
        yield* waitForBubbles(1);
        const conversation = yield* server.host.conversations.byHandle("+821012345678");
        expect(conversation).toBeDefined();
        const sessionID = Session.ID.make(conversation!.sessionID);
        yield* server.host.sessions.wait(sessionID);
        expect(
          (yield* server.host.sessions.messages({ sessionID })).some((message) =>
            message.id.startsWith("msg_discovery_"),
          ),
        ).toBe(true);
        expect(fake.bubbles).toEqual([{ handle: conversation!.handle, text: "안녕 🙂" }]);
        yield* fake.text(conversation!.handle, "안녕?", Date.now());
        yield* waitForBubbles(2);
        yield* server.host.sessions.wait(sessionID);
        expect(fake.bubbles.at(-1)).toEqual({ handle: conversation!.handle, text: "반가워!" });
        expect(JSON.stringify(yield* llm.requests())).toContain("안녕?");
        yield* server.host.client.session.update({
          sessionID,
          title: "Native OpenCode operator edit",
        });
        expect((yield* server.host.sessions.get(sessionID)).title).toBe(
          "Native OpenCode operator edit",
        );
        expect(
          (yield* Effect.promise(() =>
            server.publicWeb(new Request("http://local/rpc", { method: "POST" })),
          )).status,
        ).toBe(401);
        expect(
          (yield* Effect.promise(() => server.publicWeb(new Request("http://local/api/config"))))
            .status,
        ).toBe(404);
        const archive = yield* exportSessions(server.host.client, [sessionID]);
        expect(archive).toContain("반가워!");
        const operator = { url: listenerUrl(server.listener), token: "management-test-token" };
        const unauthorized = yield* Effect.promise(() =>
          fetch(`${operator.url}/operator/remove`, { method: "POST" }),
        );
        expect(unauthorized.status).toBe(401);
        expect(yield* server.host.conversations.byHandle(conversation!.handle)).toBeDefined();
        expect(yield* runOperatorCli(["remove", conversation!.handle], operator)).toBe(
          `Removed ${conversation!.handle}`,
        );
        expect(yield* server.host.conversations.byHandle(conversation!.handle)).toBeUndefined();
        expect(yield* sql`SELECT * FROM discovery_registration`).toEqual([]);
        expect(fake.bubbles).toHaveLength(2);
      }).pipe(Effect.provide(platform)),
    );
  } finally {
    vi.stubGlobal("fetch", network);
    await cleanup();
  }
}, 60000);

test("the public listener preserves bodies and headers and rejects an occupied port", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* servePublic(
          async (request) =>
            new Response(await request.text(), {
              status: 201,
              headers: { "x-check": request.headers.get("x-check") ?? "" },
            }),
          0,
        );
        const url = listenerUrl(listener);
        expect(listener.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
        const get = yield* Effect.promise(() => fetch(url));
        expect(get.status).toBe(201);
        expect(yield* Effect.promise(() => get.text())).toBe("");
        const post = yield* Effect.promise(() =>
          fetch(`${url}/echo`, {
            method: "POST",
            body: "payload",
            headers: { "x-check": "ok" },
          }),
        );
        expect(yield* Effect.promise(() => post.text())).toBe("payload");
        expect(post.headers.get("x-check")).toBe("ok");
        expect(
          yield* servePublic(() => Promise.resolve(new Response()), Number(new URL(url).port)).pipe(
            Effect.flip,
          ),
        ).toBeDefined();
        const failed = yield* servePublic(() => Promise.reject(new Error("closed")), 0);
        expect((yield* Effect.promise(() => fetch(listenerUrl(failed)))).status).toBe(500);
      }),
    ),
  );
});

test("production model selection uses remote OpenCode and isolates persona configuration", async () => {
  const { root, personaDirectory, cleanup } = await personaFixture("remote-settings-", valid);
  const fake = fakeMessages();
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
        const server = yield* composedTestServer(
          root,
          personaDirectory,
          llm,
          fake.messages,
          fakeGestures().gestures,
        );
        const session = yield* server.host.createSession("persona1");
        expect(session.model).toEqual({
          providerID: "opencode-go",
          id: "deepseek-v4.1-flash",
          variant: "default",
        });
        yield* llm.serve(() => TestLLM.text("fixture answer", "answer"));
        yield* server.host.sessions.prompt({
          sessionID: session.id,
          text: "check persona configuration",
        });
        yield* server.host.sessions.wait(session.id);
        const managed = yield* server.host.client.agent.list({
          location: session.location,
        });
        expect(managed.data.find((agent) => agent.id === "persona1")?.system).toContain(
          "You are Persona1",
        );
        const otherDirectory = join(root, "unrelated-project");
        yield* Effect.promise(() => mkdir(otherDirectory));
        vi.stubEnv("TOKEN_MANAGEMENT", undefined);
        expect((yield* unrelatedSession(server.host.client, otherDirectory)).outcome).toBe(
          "succeeded",
        );
        const other = yield* server.host.client.agent.list({
          location: { directory: otherDirectory },
        });
        expect(other.data.find((agent) => agent.id === "persona1")?.system ?? "").not.toContain(
          "You are Persona1",
        );
        const plugins = yield* server.host.client.plugin.list({
          location: { directory: otherDirectory },
        });
        expect(plugins.data.find((plugin) => plugin.id === "ren-ai.tools")?.state.status).toBe(
          "active",
        );
      }).pipe(Effect.provide(platform)),
    );
  } finally {
    await cleanup();
  }
}, 60000);
