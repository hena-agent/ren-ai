import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { SessionMessage } from "@opencode/schema/session-message";
import { Effect } from "effect";
import { afterAll, expect, test, vi } from "vitest";
import { startPersonaHost } from "../main.ts";
import { scriptedOverrides, valid } from "../../test/host.test-helper.ts";
import { createHost } from "./host.ts";

const offline = await vi.hoisted(async () => {
  const { Socket } = await import("node:net");
  const sockets = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Offline test");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Offline test"))),
  );
  return sockets;
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the host rejects impossible Memory limits before starting", async () => {
  for (const memory of [
    { contextTokens: 1.5, budgetTokens: 1, recentTokens: 0.5 },
    { contextTokens: 10, budgetTokens: 1.5, recentTokens: 1 },
    { contextTokens: 10, budgetTokens: 5, recentTokens: 1.5 },
    { contextTokens: 10, budgetTokens: 0, recentTokens: 1 },
    { contextTokens: 10, budgetTokens: 10, recentTokens: 1 },
    { contextTokens: 10, budgetTokens: 5, recentTokens: 0 },
    { contextTokens: 10, budgetTokens: 5, recentTokens: 5 },
  ]) {
    const error = await Effect.runPromise(
      createHost({
        configDirectory: "/not-used",
        databasePath: ":memory:",
        personaDirectory: "/not-used",
        personas: new Map(),
        providers: {},
        model: "test/probe",
        memory,
        handleForSession: () => Effect.succeed(undefined),
        health: { raise: () => Effect.void },
      }).pipe(Effect.flip, Effect.scoped),
    );
    expect(error.message).toContain("Invalid Memory budget");
  }
});

test("automatic compaction writes persona Memory and keeps his name through two summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-memory-"));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "amar.md"),
    valid
      .replace("language: ko", "language: fr")
      .replace(
        "memory: Remember his name.",
        "memory: Garde son prénom et décris les photos importantes.",
      ),
  );
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()));
          let summaries = 0;
          yield* llm.serve((request) => {
            if (JSON.stringify(request.messages).includes("Write her Memory")) {
              summaries++;
              return TestLLM.text(
                summaries === 1
                  ? "À propos de lui: Il s'appelle Jules.\nNous deux: Il m'a montré une photo de son chien.\nProjets et promesses: Se revoir.\nDernièrement: Il est rentré."
                  : "À propos de lui: Il s'appelle Jules.\nNous deux: Nous avons parlé du chien.\nProjets et promesses: Se revoir.\nDernièrement: Il prépare le dîner.",
                `memory-${summaries}`,
              );
            }
            return TestLLM.textWithUsage("Je t'écoute", "reply", 2_000);
          });
          const host = yield* startPersonaHost(join(root, "isolated"), {
            configDirectory: join(root, "config"),
            databasePath: ":memory:",
            personaDirectory,
            providers: {},
            model: "test/probe",
            memory: { contextTokens: 100_000, budgetTokens: 1_000, recentTokens: 100 },
            handleForSession: () => Effect.succeed("+821012345678"),
            health: { raise: () => Effect.void },
            overrides: scriptedOverrides(llm),
          });
          const session = yield* host.createSession("amar");
          for (const [index, text] of [
            "Je m'appelle Jules. Voici une photo de mon chien.",
            "Je suis rentré.",
            "Je prépare le dîner.",
          ].entries()) {
            yield* host.sessions.prompt({
              sessionID: session.id,
              id: SessionMessage.ID.make(`msg_memory_${index}`),
              text,
            });
            yield* host.sessions.wait(session.id).pipe(Effect.timeout("20 seconds"));
          }
          const requests = yield* llm.requests();
          const memories = requests.filter((request) =>
            JSON.stringify(request.messages).includes("Write her Memory"),
          );
          expect(summaries).toBe(2);
          expect(memories).toHaveLength(2);
          for (const request of memories) {
            expect(JSON.stringify(request)).toContain("Garde son prénom");
            expect(JSON.stringify(request)).toContain("four parts");
            expect(JSON.stringify(request)).not.toContain("Work State");
          }
          expect(JSON.stringify(memories[1])).toContain("Jules");
          const messages = yield* host.sessions.messages({ sessionID: session.id });
          expect(JSON.stringify(messages)).toContain("À propos de lui: Il s'appelle Jules.");
          expect(JSON.stringify(messages)).toContain("Je prépare le dîner.");
          expect(JSON.stringify(requests)).toContain("<conversation-checkpoint>");
          yield* llm.serve((request) =>
            JSON.stringify(request.messages).includes("Write her Memory")
              ? TestLLM.text(" ", "empty")
              : TestLLM.textWithUsage("Je t'écoute", "reply", 2_000),
          );
          const empty = yield* host.createSession("amar");
          yield* host.sessions.prompt({ sessionID: empty.id, text: "Bonjour" });
          yield* host.sessions.wait(empty.id).pipe(Effect.timeout("20 seconds"));
          yield* host.sessions.prompt({ sessionID: empty.id, text: "Encore" });
          yield* host.sessions.wait(empty.id).pipe(Effect.timeout("20 seconds"));
          expect((yield* host.sessions.get(empty.id)).outcome).toBe("failed");
          expect(
            JSON.stringify(yield* host.sessions.messages({ sessionID: empty.id })),
          ).not.toContain('"summary":" "');
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(offline).not.toHaveBeenCalled();
  expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
}, 60000);
