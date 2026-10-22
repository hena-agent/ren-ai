import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Logger, Schema } from "effect";
import { expect, test, vi } from "vitest";
import { TestLLM } from "@opencode/ai/testing";
import { readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { memoryFixture } from "../../test/memory.test-helper.ts";
import { conversationOperation } from "@ren-ai/plugin-application";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

test("a failed storage commit keeps the old documents and a lost acknowledgement replays the committed receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-storage-failure-"));
  const rename = fs.rename;
  try {
    const memory = await memoryFixture(root);
    const original = {
      scope: "life",
      markdown: "# 현재 생활\n\n이전 작업을 진행 중이다.",
      reason: "현재 생활",
    };
    await memory.run("update_memory", original, "before", "first");
    await memory.context();
    const before = await readFile(join(root, "MEMORY.md"), "utf8");
    const failing = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (String(target).endsWith("/.memory/pending.json"))
        throw Object.assign(new Error("private persistence payload"), { code: "ENOSPC" });
      await rename(source, target);
    });
    const next = {
      scope: "life",
      markdown: "# 현재 생활\n\n새로운 작업을 시작했다.",
      reason: "작업이 바뀌었다.",
    };
    await expect(memory.run("update_memory", next, "commit", "next")).rejects.toThrow(
      "private persistence payload",
    );
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toBe(before);
    failing.mockRestore();
    const remove = fs.rm;
    const acknowledgement = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (String(path).endsWith("/.memory/pending.json")) throw new Error("Acknowledgement lost");
      await remove(path, options);
    });
    await expect(memory.run("update_memory", next, "commit", "next")).rejects.toThrow(
      "Acknowledgement lost",
    );
    acknowledgement.mockRestore();
    expect(await (await memoryFixture(root)).run("update_memory", next, "commit", "next")).toBe(
      "Short-term Memory updated",
    );
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toContain("새로운 작업");
    expect(await readdir(join(root, ".memory"))).toEqual(["observations.json", "receipts.json"]);
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

test("real OC context failures are diagnosed before recovery without exposing private Memory", () =>
  withRemoteHost((remote, _directory, { llm }) =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const capture = (...items: Parameters<typeof console.log>) => {
        logs.push(items.map((item) => JSON.stringify(item)).join(" "));
      };
      const logged = vi.spyOn(console, "log").mockImplementation(capture);
      const errors = vi.spyOn(console, "error").mockImplementation(capture);
      try {
        const session = yield* remote.createSession("persona1");
        const path = session.location.directory;
        yield* Effect.promise(() => writeFile(join(path, "STATE.md"), "private invalid state"));
        let calls = 0;
        yield* llm.serve((request) => {
          if (request.tools.some((tool) => tool.name === "remember")) calls++;
          return TestLLM.text("hello", "answer");
        });
        yield* remote.sessions.prompt({ sessionID: session.id, text: "hello" });
        yield* remote.sessions.wait(session.id);
        expect((yield* remote.sessions.get(session.id)).outcome).toBe("failed");
        expect(calls).toBe(0);
        const diagnostic = logs.find(
          (entry) => entry.includes("memory.context") && entry.includes("requestID"),
        );
        expect(diagnostic).toContain(session.id);
        expect(diagnostic).toContain("causeName");
        expect(diagnostic).toContain("durationMs");
        expect(diagnostic).not.toContain("private invalid state");
        yield* Effect.promise(() => rm(join(path, "STATE.md")));
        yield* remote.retry(session.id);
        yield* remote.sessions.wait(session.id);
        expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
        expect((yield* Effect.promise(() => readRuntime(path)))?.state).toBeUndefined();
        let attempted = false;
        yield* llm.serve((request) => {
          if (!attempted && request.tools.some((tool) => tool.name === "update_state")) {
            attempted = true;
            return TestLLM.tool("invalid-state", "update_state", {
              scores: { energy: 12 },
              additions: {},
              remove: [],
              reason: "private_input_reason",
            });
          }
          return TestLLM.text("existing state preserved", "answer");
        });
        yield* remote.sessions.prompt({ sessionID: session.id, text: "Change the current state" });
        yield* remote.sessions.wait(session.id);
        const validation = logs.find(
          (entry) => entry.includes("update_state") && entry.includes("causeName"),
        );
        expect(validation).toContain(session.id);
        expect(validation).toContain("SchemaError");
        expect(validation).toContain("callID");
        expect(validation).not.toContain("private_input_reason");
        expect((yield* Effect.promise(() => readRuntime(path)))?.state).toBeUndefined();
      } finally {
        logged.mockRestore();
        errors.mockRestore();
      }
    }),
  ));

test("Conversation diagnostics retain cause metadata and correlation while excluding error payloads", async () => {
  const logs: string[] = [];
  const logger = Logger.map(Logger.formatJson, (line) => {
    logs.push(line);
  });
  const root = Object.assign(new Error("private-key private memory"), { code: "ENOSPC" });
  const noStack = new Error("private-key");
  delete noStack.stack;
  const causes = [
    new Error("private wrapper", { cause: root }),
    noStack,
    "private-key",
    Object.assign(new Error("private-key"), { code: "private_key" }),
  ];
  for (const [index, cause] of causes.entries()) {
    const failed = await Effect.runPromise(
      conversationOperation(
        "remember",
        "ses_private",
        async () => {
          throw cause;
        },
        index === 0 ? "call-1" : undefined,
      ).pipe(Effect.withLogger(logger), Effect.flip),
    );
    expect(failed.message).toContain("Conversation remember failed");
    const diagnostic = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ annotations: Schema.Struct({ requestID: Schema.String }) }),
      ),
    )(logs.at(-1));
    expect(failed.message).toContain(diagnostic.annotations.requestID);
  }
  expect(logs).toHaveLength(4);
  expect(logs[0]).toContain("ENOSPC");
  expect(logs[0]).toContain("call-1");
  expect(logs[0]).toContain("requestID");
  expect(logs[0]).toContain("durationMs");
  expect(logs[0]).toContain("stack");
  expect(logs.join("\n")).not.toContain("private-key");
  expect(logs.join("\n")).not.toContain("private memory");
  expect(logs.join("\n")).not.toContain("private wrapper");
});
