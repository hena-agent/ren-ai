import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { personaMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { writeSessionBinding } from "../../../../packages/plugins/session-folder/src/bindings.ts";
import {
  withPersona,
  readers,
  state,
  record,
  restoreMemory,
} from "../../test/memory.test-helper.ts";

test("two sessions share life and proficiency but route affection, user facts and identical call IDs to their own relationship", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    await a.run(
      "update_state",
      state({ energy: 35, affection: 75 }),
      "state",
      "private-message-id",
    );
    await a.run(
      "remember",
      record("relationship", "private green tea preference"),
      "same-call",
      "a-private-source",
    );
    await b.run(
      "remember",
      record("relationship", "private black tea preference"),
      "same-call",
      "b-private-source",
    );
    await a.run("remember", record("life", "I bought tea for myself"), "life", "a-private-source");
    const current = await b.context();
    expect(current).toContain("energy: 35");
    expect(current).toContain("affection: 25");
    expect(current).not.toContain("affection: 75");
    expect(current).toContain("another Conversation");
    expect(current).not.toContain("private-message-id");
    const results = await b.run("search_memory", { query: "tea" }, "search", "b");
    expect(results).toContain('"scope":"life"');
    expect(results).toContain("I bought tea for myself");
    expect(results).toContain("private black tea preference");
    expect(results).not.toContain("private green tea preference");
    expect(await readFile(join(root, "STATE.md"), "utf8")).not.toContain("affection");
  }));

const captureConflicts = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

test("disjoint shared writes compose; overlapping writes return current provenance without leaking payload into diagnostics", () =>
  withPersona(async (root) => {
    const warn = captureConflicts();
    try {
      const { a, b } = await readers(root);
      await Promise.all([
        a.run(
          "update_state",
          state({ energy: 30 }, "private-safe-reason-token"),
          "first",
          "source",
        ),
        b.run("update_state", state({ stress: 45 }), "second", "source"),
      ]);
      const rejected = await b.run("update_state", state({ energy: 90 }), "collision", "source");
      expect(rejected).toContain('"conflict":true');
      expect(rejected).toContain('"value":30');
      expect(rejected).toContain("private-safe-reason-token");
      expect(rejected).toContain("another Conversation");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-safe-reason-token");
      expect(JSON.stringify(warn.mock.calls)).toContain("SHARED_MEMORY_CONFLICT");
      expect((await readRuntime(root))?.state).toMatchObject({ energy: 30, stress: 45 });
      await b.run("update_state", state({ energy: 65 }), "retry", "source");
      expect((await readRuntime(root))?.state?.energy).toBe(65);
      expect(
        await a.run(
          "update_state",
          state({ energy: 30 }, "private-safe-reason-token"),
          "first",
          "source",
        ),
      ).not.toContain("conflict");
      expect((await readRuntime(root))?.state?.energy).toBe(65);
    } finally {
      warn.mockRestore();
    }
  }));

test("compaction does not refresh a stale model's read and a fresh session must read before overwriting shared documents", () =>
  withPersona(async (root) => {
    const warn = captureConflicts();
    try {
      const a = personaMemory(root, "sesa");
      const b = personaMemory(root, "sesb");
      await a.context();
      expect(await b.run("update_state", state({ energy: 90 }), "unread", "source")).toContain(
        "conflict",
      );
      await b.context();
      await a.run("update_state", state({ energy: 20 }), "first", "source");
      expect(await b.context(false)).toContain("energy: 20");
      expect(await b.run("update_state", state({ energy: 80 }), "stale", "source")).toContain(
        "conflict",
      );
      await b.context();
      expect(await b.run("update_state", state({ energy: 80 }), "fresh", "source")).not.toContain(
        "conflict",
      );
    } finally {
      warn.mockRestore();
    }
  }));

test("shared long-term edits require recall, forgetting uses only same-session dice and atomically clears the current short-term note", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    await a.run("remember", record("life", "tea-detail-to-forget"), "new", "source");
    const stored = (await readRuntime(root))!.longTerm[0]!;
    await a.run(
      "update_memory",
      { scope: "life", markdown: "tea-detail-to-forget", reason: "Remember" },
      "short",
      "source",
    );
    await b.context();
    await b.run("search_memory", { query: "tea" }, "search", "source");
    await a.roll("dice", "source", () => 0.2);
    const forget = {
      ...record("life", ""),
      id: stored.id,
      clarity: "forgotten",
      summary: "",
      diceCall: "dice",
      shortTerm: "I am resting.",
    };
    await expect(b.run("remember", forget, "forbid-dice", "source")).rejects.toThrow(
      "this session",
    );
    await b.roll("dice", "source", () => 0.7);
    await b.run("remember", forget, "forget", "source");
    const current = await a.context();
    expect(current).toContain("forgotten");
    expect(current).toContain("I am resting.");
    expect(current).not.toContain("tea-detail-to-forget");
    expect(await a.run("search_memory", { query: "tea" }, "search", "source")).toBe("[]");
  }));

test("read-only bindings replay completed receipts but reject fresh dice and mutations", () =>
  withPersona(async (root) => {
    const a = personaMemory(root, "sesa");
    await a.context();
    await a.roll("dice", "source", () => 0.5);
    await writeSessionBinding(root, root, "sesa", {
      personaID: "persona1",
      conversationKey: "a",
      writable: false,
    });
    await expect(a.context()).resolves.toContain("life");
    const random = vi.fn<() => number>(() => 0.9);
    expect(await a.roll("dice", "source", random)).toBe("5000");
    expect(random).not.toHaveBeenCalled();
    await expect(a.roll("new-dice", "source")).rejects.toThrow("read-only");
    await expect(
      a.run("remember", record("relationship", "tea"), "write", "source"),
    ).rejects.toThrow("read-only");
    await expect(personaMemory(root, "sesmissing").context()).rejects.toThrow("ENOENT");
  }));

test("partial root WAL recovery completes both scopes before readers or a persisted receipt replay", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    const input = state({ energy: 80, affection: 70 });
    const nextState = (await readFile(join(root, "STATE.md"), "utf8")).replace(
      "energy: 60",
      "energy: 80",
    );
    const nextRelationship = (
      await readFile(join(root, "conversations", "a", "STATE.md"), "utf8")
    ).replace("affection: 25", "affection: 70");
    const receipts = JSON.stringify({
      "sesa:interrupted": {
        operation: "update_state",
        inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        output: "Recovered committed result",
      },
    });
    await writeFile(
      join(root, ".memory", "pending.json"),
      JSON.stringify([
        { name: "STATE.md", text: nextState },
        { name: ".memory/receipts.json", text: receipts },
        { name: "conversations/a/STATE.md", text: nextRelationship },
      ]),
    );
    await writeFile(join(root, "STATE.md"), nextState);
    await writeFile(join(root, ".memory", "receipts.json"), receipts);
    const [context, other, replay] = await Promise.all([
      a.context(),
      b.context(),
      a.run("update_state", input, "interrupted", "source"),
    ]);
    expect(context).toContain("energy: 80");
    expect(context).toContain("affection: 70");
    expect(other).toContain("energy: 80");
    expect(other).toContain("affection: 25");
    expect(replay).toBe("Recovered committed result");
    await expect(readFile(join(root, ".memory", "pending.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }));

test("shared short-term conflicts and state conflicts never partially update the relationship", () =>
  withPersona(async (root) => {
    const warn = captureConflicts();
    try {
      const { a, b } = await readers(root);
      await a.run(
        "update_memory",
        { scope: "life", markdown: "I am painting.", reason: "Work began" },
        "short",
        "source",
      );
      const conflict = await b.run(
        "update_memory",
        { scope: "life", markdown: "I am sleeping.", reason: "Rest" },
        "short",
        "source",
      );
      expect(conflict).toContain("I am painting.");
      expect(conflict).toContain("Work began");
      await a.run("update_state", state({ energy: 10 }), "state", "source");
      expect(
        await b.run("update_state", state({ energy: 90, affection: 90 }), "state", "source"),
      ).toContain("conflict");
      expect(await b.context()).toContain("affection: 25");
      expect(await b.context()).not.toContain("affection: 90");
      expect((await readRuntime(root))?.shortTerm).toBe("I am painting.");
      await b.run(
        "update_memory",
        { scope: "relationship", markdown: "A private promise.", reason: "Agreed" },
        "private",
        "source",
      );
      expect(await a.context()).not.toContain("A private promise");
    } finally {
      warn.mockRestore();
    }
  }));

test("explicit additions route by scope and proficiency becomes part of the shared life", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    const addition = { value: true, meaning: "Current plan", reason: "Decided today" };
    await expect(
      a.run(
        "update_state",
        { ...state({}), additions: { plan: addition } },
        "missing-scope",
        "source",
      ),
    ).rejects.toThrow("explicit");
    await a.run(
      "update_state",
      {
        ...state({}),
        scope: "life",
        languageProficiency: { ko: "beginner" },
        additions: { plan: addition },
      },
      "life",
      "source",
    );
    await a.run(
      "update_state",
      { ...state({}), scope: "relationship", additions: { "private-plan": addition } },
      "relationship",
      "source",
    );
    const current = await b.context();
    expect(current).toContain("ko: beginner");
    expect(current).toContain("plan:");
    expect(current).not.toContain("private-plan");
    await b.run(
      "update_state",
      { ...state({}), scope: "life", remove: ["plan"] },
      "remove",
      "source",
    );
    expect((await readRuntime(root))?.additional).toEqual({});
  }));

test("shared record corrections compare the recalled version and scope-tagged searches remain bounded", () =>
  withPersona(async (root) => {
    const logs = captureConflicts();
    try {
      const { a, b } = await readers(root);
      await a.run("remember", record("life", "tea at the studio"), "create", "source");
      const original = (await readRuntime(root))!.longTerm[0]!;
      const correction = { ...record("life", "tea at home"), id: original.id };
      expect(await b.run("remember", correction, "unread", "source")).toContain("conflict");
      await b.run("search_memory", { query: "tea" }, "read", "source");
      await a.run("remember", { ...correction, text: "tea in the garden" }, "correct", "source");
      const stale = await b.run("remember", correction, "stale", "source");
      expect(stale).toContain("tea in the garden");
      expect(stale).toContain("another Conversation");
      expect(stale).not.toContain('"source":"a"');
      await expect(
        a.run("remember", { ...correction, text: "different replay" }, "correct", "source"),
      ).rejects.toThrow("different input");
      for (let index = 0; index < 12; index++)
        await a.run(
          "remember",
          record(index % 2 ? "life" : "relationship", `tea memory ${index}`),
          `many-${index}`,
          "source",
        );
      const results = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Array(Schema.Struct({ scope: Schema.Literals(["life", "relationship"]) })),
        ),
      )(await a.run("search_memory", { query: "tea" }, "bounded", "source"));
      expect(results).toHaveLength(10);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scope: "life" }),
          expect.objectContaining({ scope: "relationship" }),
        ]),
      );
    } finally {
      logs.mockRestore();
    }
  }));

test("short-term change summaries are bounded since the last model read and remove forgotten details from provenance", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    for (let index = 0; index < 12; index++)
      await a.run(
        "update_memory",
        { scope: "life", markdown: `Life ${index}`, reason: `changed-life-${index}` },
        `change-${index}`,
        "private-source",
      );
    const current = await b.context();
    expect(current).not.toContain('"reason":"changed-life-0"');
    expect(current).toContain('"reason":"changed-life-2"');
    expect(current).toContain('"reason":"changed-life-11"');
    expect(current).not.toContain("private-source");
    expect(await b.context()).toContain("<life-memory-changes>[]</life-memory-changes>");
    await a.run("remember", record("life", "forgotten-specific-detail"), "new", "source");
    await a.run(
      "update_memory",
      { scope: "life", markdown: "forgotten-specific-detail", reason: "forgotten-specific-detail" },
      "specific",
      "source",
    );
    const id = (await readRuntime(root))!.longTerm[0]!.id;
    await a.roll("forget-roll", "source");
    await a.run(
      "remember",
      {
        ...record("life", ""),
        id,
        clarity: "forgotten",
        summary: "",
        reason: "forgotten-specific-detail",
        shortTerm: "Resting",
        diceCall: "forget-roll",
      },
      "forget",
      "source",
    );
    expect(await b.context()).not.toContain("forgotten-specific-detail");
  }));

test("rebuilding a native session keeps this Conversation's provenance but gives dice a new session namespace", () =>
  withPersona(async (root) => {
    const original = personaMemory(root, "sesa");
    await original.context();
    await original.run("update_state", state({ energy: 35 }), "state", "old-native-message");
    await original.roll("same-call", "source", () => 0.2);
    await writeSessionBinding(root, root, "sesrebuilt", {
      personaID: "persona1",
      conversationKey: "a",
      writable: true,
    });
    const rebuilt = personaMemory(root, "sesrebuilt");
    const current = await rebuilt.context();
    expect(current).toContain("this Conversation");
    expect(current).not.toContain("another Conversation");
    expect(current).not.toContain("old-native-message");
    expect(await rebuilt.roll("same-call", "source", () => 0.8)).toBe("8000");
    expect(await original.roll("same-call", "source", () => 0.9)).toBe("2000");
  }));

test("exported last-read checkpoints retain unseen changes after restore without authorizing stale model writes", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    await a.run(
      "update_memory",
      { scope: "life", markdown: "Day one", reason: "Started painting" },
      "one",
      "source",
    );
    await b.context();
    await a.run(
      "update_memory",
      { scope: "life", markdown: "Day two", reason: "Finished painting" },
      "two",
      "source",
    );
    const exported = (await readRuntime(root))!;
    await withPersona(async (restoredRoot) => {
      await restoreMemory(restoredRoot, exported);
      const restored = personaMemory(restoredRoot, "sesb");
      const summary = await restored.context(false);
      expect(summary).toContain('"reason":"Finished painting"');
      expect(summary).not.toContain('"reason":"Started painting"');
      expect(
        await restored.run("update_state", state({ energy: 90 }), "stale-after-restore", "source"),
      ).toContain("conflict");
      expect(await restored.context()).toContain('"reason":"Finished painting"');
      expect(await restored.context()).toContain("<life-memory-changes>[]</life-memory-changes>");
    });
  }));
