import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { conversationMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";

test("invalid state and memory updates never change the last committed Conversation documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-validation-"));
  try {
    const memory = conversationMemory(root);
    const state = {
      scores: {},
      additions: {
        "연락하고 싶음": { value: true, meaning: "현재 연락 의사", reason: "새 화제가 생각났다." },
      },
      remove: [],
      reason: "현재 상황",
    };
    await memory.run("update_state", state, "state", "first");
    const before = await memory.context();
    await expect(
      memory.run("update_state", { ...state, scores: { energy: 12 } }, "partial", "first"),
    ).rejects.toThrow("all five");
    await expect(
      memory.run("update_state", { ...state, scores: { energy: 101 } }, "invalid-score", "first"),
    ).rejects.toThrow("tool input");
    await expect(
      memory.run(
        "update_state",
        { ...state, additions: { traits: state.additions["연락하고 싶음"] } },
        "reserved",
        "first",
      ),
    ).rejects.toThrow("built-in");
    await expect(
      memory.run(
        "update_memory",
        { markdown: "private", reason: "private", extra: "private" },
        "extra",
        "first",
      ),
    ).rejects.toThrow("tool input");
    await expect(
      memory.run("update_memory", { markdown: "private", reason: "private" }, "state", "first"),
    ).rejects.toThrow("different input");
    await expect(
      memory.run("update_state", { ...state, reason: "changed" }, "state", "first"),
    ).rejects.toThrow("different input");
    const record = {
      topic: "취향",
      text: "차를 좋아한다.",
      summary: "차 취향",
      clarity: "clear",
      reason: "상대가 말했다.",
    };
    await expect(
      memory.run("remember", { ...record, id: "another-conversation" }, "missing", "first"),
    ).rejects.toThrow("not found");
    await expect(
      memory.run(
        "remember",
        { ...record, diceCall: "another-conversation" },
        "missing-dice",
        "first",
      ),
    ).rejects.toThrow("Dice decision");
    await expect(
      memory.run("remember", { ...record, diceCall: "state" }, "wrong-dice", "first"),
    ).rejects.toThrow("Dice decision");
    await expect(
      memory.run("remember", { ...record, text: " " }, "empty", "first"),
    ).rejects.toThrow("appropriate");
    await expect(
      memory.run(
        "remember",
        { ...record, clarity: "faded", summary: " " },
        "empty-summary",
        "first",
      ),
    ).rejects.toThrow("appropriate");
    expect(await memory.context()).toBe(before);
    await memory.run(
      "update_state",
      { ...state, additions: {}, remove: ["연락하고 싶음"] },
      "remove",
      "next",
    );
    expect(await memory.context()).not.toContain("연락하고 싶음");
    await memory.run(
      "update_state",
      {
        ...state,
        scores: { mood: 50, energy: 40, stress: 30, connection: 60, solitude: 70 },
        traits: { 망설임: { strength: 70, active: false, persistence: "lasting" } },
      },
      "initialize",
      "next",
    );
    expect(await memory.context()).toContain("active: false");
    await memory.run("remember", record, "first-record", "next");
    await memory.run(
      "remember",
      { ...record, topic: "다른 취향", text: "커피도 좋아한다." },
      "second-record",
      "next",
    );
    expect(
      JSON.parse(await memory.run("search_memory", { query: "취향 차" }, "search", "next")),
    ).toHaveLength(2);
    const stored = await readRuntime(root);
    await expect(
      memory.run(
        "remember",
        {
          ...record,
          id: stored!.longTerm[0]!.id,
          clarity: "forgotten",
          shortTerm: "# 현재 생활\n\n산책 중이다.",
        },
        "without-roll",
        "next",
      ),
    ).rejects.toThrow("recorded dice");
    const roll = await memory.roll("roll", "next", () => 0);
    expect(roll).toBe("0");
    await memory.run(
      "remember",
      {
        ...record,
        id: stored!.longTerm[0]!.id,
        text: "새로 알려준 취향",
        shortTerm: "# 현재 생활\n\n새 취향을 들었다.",
      },
      "correct",
      "next",
    );
    expect(
      await memory.run("search_memory", { query: "새로 알려준" }, "corrected-search", "next"),
    ).toContain("새로 알려준 취향");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt execution records and incomplete or invalid Markdown fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-corrupt-"));
  try {
    const memory = conversationMemory(root);
    await writeFile(join(root, "STATE.md"), "private invalid state");
    await expect(memory.context()).rejects.toThrow("both initial");
    await writeFile(join(root, "MEMORY.md"), "private memory");
    await expect(memory.context()).rejects.toThrow("STATE.md");
    await rm(join(root, "STATE.md"));
    await mkdir(join(root, "STATE.md"));
    await expect(memory.context()).rejects.toThrow("could not be read");
    await rm(join(root, "STATE.md"), { recursive: true });
    await rm(join(root, "MEMORY.md"));
    await memory.roll("create", "first");
    await expect(memory.restore({ private: "payload" })).rejects.toThrow("snapshot");
    const receipts = join(root, ".memory", "receipts.json");
    await writeFile(receipts, "not JSON: private");
    await expect(memory.context()).rejects.toThrow("memory files");
    await writeFile(receipts, JSON.stringify({ private: "payload" }));
    await expect(memory.context()).rejects.toThrow("memory files");
    await rm(receipts);
    await mkdir(receipts);
    await expect(memory.context()).rejects.toThrow("could not be read");
    const alias = join(root, "alias");
    const empty = join(root, "empty");
    await mkdir(empty);
    await symlink(empty, alias);
    try {
      await expect(conversationMemory(alias).context()).rejects.toThrow("real session directory");
    } finally {
      await rm(alias);
    }
    await expect(conversationMemory(join(root, "MEMORY.md")).context()).rejects.toThrow(
      "real session directory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
