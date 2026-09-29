import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, Layer, Sink, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Session } from "@opencode/schema/session";
import { afterAll, expect, test, vi } from "vitest";
import { fakeMessages } from "./messages/messages.fake.ts";
import { notice } from "@ren-ai/onboarding";
import { fakeGestures } from "./gestures/gestures.fake.ts";
import { noticeCopy } from "./onboarding/onboarding.ts";
import { runOperatorCli } from "./operator/cli.ts";
import { scriptedOverrides } from "./opencode/scripted-overrides.test-helper.ts";
import { model, valid } from "../test/host.test-helper.ts";
import { composeServer } from "./server.ts";
import type { SendDiagnostic } from "./messages/send-diagnostic.ts";
import { servePublic } from "./public-listener.ts";

vi.mock("@effect/sql-sqlite-bun", async () => ({
  SqliteClient: { layer: (await import("@effect/sql-sqlite-node")).SqliteClient.layer },
}));

const xdg = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const paths = await import("node:path");
  const root = fs.mkdtempSync(paths.join(os.tmpdir(), "server-xdg-"));
  for (const name of ["config", "data", "state", "cache"]) {
    const location = paths.join(root, name);
    fs.mkdirSync(location);
    process.env[`XDG_${name.toUpperCase()}_HOME`] = location;
  }
  return root;
});
afterAll(() => rmSync(xdg, { recursive: true, force: true }));

const secrets = {
  OPENCODE_GO_KEY: "scripted",
  TURNSTILE_SECRET: "turnstile-test",
  VIEWER_PASSWORD: "viewer-test",
  DISCORD_WEBHOOK_URL: "https://discord.invalid/hook",
};

const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(request.url.includes("siteverify") ? '{"success":true}' : "ok", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
);
const platform = Layer.mergeAll(
  NodeServices.layer,
  SqliteClient.layer({ filename: ":memory:" }),
  Layer.succeed(HttpClient.HttpClient, http),
);

const processes = ChildProcessSpawner.make(() =>
  Effect.succeed(
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      unref: Effect.succeed(Effect.void),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.make(new TextEncoder().encode("Filesystem 100 99 1 1% /")),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
  ),
);

test("composed HTTP, real OpenCode, iMessage and operator socket complete a Conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "composed-server-"));
  const personaDirectory = join(root, "persona");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "persona1.md"), valid);
  const fake = fakeMessages();
  const ui = fakeGestures();
  let capturedDiagnostic: SendDiagnostic | undefined;
  let greeted = false;
  let replied = false;
  const offlineFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('{"success":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
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
          const server = yield* composeServer(
            {
              stateDirectory: root,
              personaDirectory,
              publicPort: 0,
              viewerPort: 0,
              diagnoseNextSend: true,
              noticeVersion: "v1",
              secrets,
              host: {
                model: "test/probe",
                providers: {},
                overrides: scriptedOverrides(llm, model),
                memory: { contextTokens: 100_000, budgetTokens: 60_000, recentTokens: 12_000 },
              },
            },
            {
              messages: (_health, diagnostic) => {
                expect(diagnostic).toBeDefined();
                capturedDiagnostic = diagnostic;
                return Effect.succeed(fake.messages);
              },
              gestures: () => Effect.succeed(ui.gestures),
            },
          );
          const body = JSON.stringify({
            handle: "+821012345678",
            locale: "ko",
            privacyNoticeVersion: "v1",
            turnstileToken: "human",
          });
          const response = yield* Effect.promise(() =>
            server.publicWeb(
              new Request("http://local/onboarding", {
                method: "POST",
                headers: { "content-type": "application/json", origin: "https://msg.hena.dev" },
                body,
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toBe("sent");
          const conversation = yield* server.host.conversations.byHandle("+821012345678");
          expect(conversation).toBeDefined();
          const waitForBubbles = (count: number) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 200 && fake.bubbles.length < count; attempt++) {
                yield* Effect.sleep("20 millis");
              }
              expect(fake.bubbles).toHaveLength(count);
            });
          yield* waitForBubbles(2);
          yield* server.host.sessions
            .wait(Session.ID.make(conversation!.sessionID))
            .pipe(Effect.timeout("20 seconds"));
          expect(
            (yield* server.host.sessions.messages({
              sessionID: Session.ID.make(conversation!.sessionID),
            })).some((message) => message.id === `msg_onboarding_${conversation!.sessionID}`),
          ).toBe(true);
          expect(fake.bubbles).toEqual([
            { handle: conversation!.handle, text: noticeCopy.ko },
            { handle: conversation!.handle, text: "안녕 🙂" },
          ]);
          expect(yield* capturedDiagnostic!.claim(-1, "unused", "unused")).toBe(false);
          yield* fake.text(conversation!.handle, "안녕?", Date.now());
          yield* waitForBubbles(3);
          yield* server.host.sessions
            .wait(Session.ID.make(conversation!.sessionID))
            .pipe(Effect.timeout("20 seconds"));
          expect(fake.bubbles.at(-1)).toEqual({ handle: conversation!.handle, text: "반가워!" });
          expect(JSON.stringify(yield* llm.requests())).toContain("안녕?");
          const authorization = `Basic ${Buffer.from("opencode:viewer-test").toString("base64")}`;
          for (const route of ["/api/config", "/api/provider", "/openapi.json"]) {
            const denied = yield* Effect.promise(() =>
              server.viewerWeb(
                new Request(`http://viewer${route}`, { headers: { authorization } }),
              ),
            );
            expect(process.env["HOME"]).toBe(join(root, "isolated"));
            expect(server.socket).toBe(join(root, "operator", "operator.sock"));
            expect(denied.status).toBe(403);
          }
          expect(yield* runOperatorCli(["remove", conversation!.handle], server.socket)).toBe(
            `Removed ${conversation!.handle}`,
          );
          expect(yield* server.host.conversations.byHandle(conversation!.handle)).toBeUndefined();
          expect(fake.bubbles).toHaveLength(3);
        }).pipe(
          Effect.provide(platform),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, processes),
        ),
      ),
    );
  } finally {
    vi.stubGlobal("fetch", offlineFetch);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test("production model settings and public listener reject invalid binding", async () => {
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
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        expect(address.address).toBe("127.0.0.1");
        const url = `http://127.0.0.1:${address.port}`;
        const get = yield* Effect.promise(() => fetch(url));
        expect(get.status).toBe(201);
        expect(yield* Effect.promise(() => get.text())).toBe("");
        const post = yield* Effect.promise(() =>
          fetch(`${url}/onboarding`, {
            method: "POST",
            body: "payload",
            headers: { "x-check": "ok" },
          }),
        );
        expect(yield* Effect.promise(() => post.text())).toBe("payload");
        expect(post.headers.get("x-check")).toBe("ok");
        expect(
          yield* servePublic(() => Promise.resolve(new Response()), address.port).pipe(Effect.flip),
        ).toBeDefined();
      }),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* servePublic(() => Promise.reject(new Error("closed")), 0);
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Expected TCP listener");
        yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${address.port}`).catch(() => undefined),
        );
      }),
    ),
  );
});

test("production settings are isolated and the model is configured without contacting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-settings-"));
  const personaDirectory = join(root, "persona");
  await mkdir(personaDirectory);
  await writeFile(join(personaDirectory, "persona1.md"), valid);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline test"));
  const fake = fakeMessages();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* composeServer(
            {
              stateDirectory: root,
              personaDirectory,
              publicPort: 0,
              viewerPort: 0,
              secrets,
            },
            {
              messages: () => Effect.succeed(fake.messages),
              gestures: () => Effect.succeed(fakeGestures().gestures),
            },
          );
          const session = yield* server.host.createSession("persona1");
          expect(session.model).toEqual({
            providerID: "opencode-go",
            id: "deepseek-v4.1-flash",
            variant: "max",
          });
          const config = yield* Effect.promise(() =>
            server.host.web(new Request("http://host/api/config")),
          );
          const body = yield* Effect.promise(() => config.text());
          expect(body).toContain('"apiKey":"scripted"');
          expect(body).toContain(join(root, "isolated", "config"));
          expect(body).toContain('"buffer":400000');
          expect(body).toContain('"tokens":12000');
          yield* server.backup.tick;
          const files = yield* Effect.promise(() => readdir(join(root, "backups")));
          expect(
            files.filter((name) => /^(?:server|opencode)-\d+\.sqlite$/.test(name)),
          ).toHaveLength(2);
          const pending = yield* Effect.promise(() =>
            server.publicWeb(
              new Request("http://local/onboarding", {
                method: "POST",
                headers: { "content-type": "application/json", origin: "https://msg.hena.dev" },
                body: JSON.stringify({
                  handle: "+821012345678",
                  locale: "ko",
                  privacyNoticeVersion: "pending",
                  turnstileToken: "human",
                }),
              }),
            ),
          );
          expect(pending.status).toBe(400);
          const rejectedTurnstile = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response('{"success":false}', {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          );
          expect(
            yield* server.host
              .onboard({
                handle: "+821012345678",
                locale: "ko",
                privacyNoticeVersion: notice.ko.version,
                turnstileToken: "human",
              })
              .pipe(
                Effect.provide(Layer.succeed(HttpClient.HttpClient, rejectedTurnstile)),
                Effect.flip,
              ),
          ).toBe("Turnstile failed");
          expect(fake.bubbles).toEqual([]);
          expect(network).not.toHaveBeenCalled();
        }).pipe(
          Effect.provide(platform),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, processes),
        ),
      ),
    );
  } finally {
    network.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
