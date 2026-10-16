import { mkdtemp, rm, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { conversationMemory } from "@ren-ai/plugin-session-folder/memory";

test("a conversation persists state and short-term memory together with replay receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-memory-"));
  try {
    await writeFile(
      join(root, "STATE.md"),
      "---\nmood: 55\nenergy: 60\nstress: 35\nconnection: 55\nsolitude: 60\ntraits: {}\n---\n",
    );
    await writeFile(join(root, "MEMORY.md"), "# 현재 생활\n\n사진전을 준비 중이다.");
    const memory = conversationMemory(root);
    const input = {
      scores: { energy: 30 },
      additions: {
        "사진전 준비 단계": {
          value: "작품 선정 중",
          meaning: "현재 작업 단계",
          reason: "작품을 고르는 중이라고 이야기했다.",
        },
      },
      remove: [],
      reason: "밤샘 작업으로 피곤하다.",
    };
    const changed = await memory.run("update_state", input, "state-call", "message-1");
    await memory.run(
      "update_memory",
      {
        markdown:
          "# 현재 생활\n\n사진전 작품을 고르는 중이다. 내일 상대에게 진행 상황을 이야기하기로 했다.",
        reason: "새 약속을 확인했다.",
      },
      "memory-call",
      "message-2",
    );
    await memory.run(
      "update_state",
      { scores: { energy: 45 }, additions: {}, remove: [], reason: "휴식을 취했다." },
      "later-call",
      "message-3",
    );
    expect(
      await conversationMemory(root).run("update_state", input, "state-call", "message-1"),
    ).toBe(changed);
    const current = await conversationMemory(root).context();
    expect(current).toContain("energy: 45");
    expect(current).toContain("작품 선정 중");
    expect(current).toContain("내일 상대에게 진행 상황");
    expect(await readFile(join(root, "STATE.md"), "utf8")).toContain("energy: 45");
    expect(await readFile(join(root, "MEMORY.md"), "utf8")).toContain("내일 상대에게 진행 상황");
    expect(await readdir(join(root, ".memory"))).toEqual(["receipts.json"]);
    expect((await lstat(join(root, "STATE.md"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(root, "MEMORY.md"))).isSymbolicLink()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown edits are authoritative after tool updates and dice writes only execution receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-markdown-source-"));
  try {
    const memory = conversationMemory(root);
    const input = {
      topic: "취향",
      text: "차를 좋아한다.",
      summary: "차 취향",
      clarity: "clear",
      reason: "상대가 말했다.",
    };
    const { id } = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
    )(await memory.run("remember", input, "learn", "first"));
    const statePath = join(root, "STATE.md");
    const longPath = join(root, "long-term", `${id}.md`);
    const state = (await readFile(statePath, "utf8")).replace(
      "additional: {}",
      "additional:\n  note:\n    value: true\n    meaning: 수정한 상태\n    reason: 직접 확인",
    );
    const longTerm = (await readFile(longPath, "utf8")).replace(
      "차를 좋아한다.",
      "커피를 좋아한다.",
    );
    await writeFile(statePath, state);
    await writeFile(join(root, "MEMORY.md"), "# 현재 생활\n\n직접 수정한 기억.");
    await writeFile(longPath, longTerm);
    const restarted = conversationMemory(root);
    expect(await restarted.context()).toContain("수정한 상태");
    expect(await restarted.context()).toContain("직접 수정한 기억");
    expect(await restarted.run("search_memory", { query: "커피" }, "search", "next")).toContain(
      "커피를 좋아한다",
    );
    const before = await lstat(longPath);
    const stateBefore = await lstat(statePath);
    await restarted.roll("roll", "next", () => 0.3);
    expect((await lstat(longPath)).ino).toBe(before.ino);
    expect((await lstat(statePath)).ino).toBe(stateBefore.ino);
    expect(await readFile(statePath, "utf8")).toBe(state);
    expect(await readFile(longPath, "utf8")).toBe(longTerm);
    expect(await readdir(join(root, ".memory"))).toEqual(["receipts.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent Conversation writers preserve sibling updates and deduplicate the same memory and dice calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-concurrent-"));
  try {
    const first = conversationMemory(root);
    const second = conversationMemory(root);
    const record = {
      topic: "취향",
      text: "차를 좋아한다.",
      summary: "차 취향",
      clarity: "clear",
      reason: "상대가 말했다.",
    };
    const random = vi.fn<() => number>(() => 0.5);
    const [left, right, roll, replay] = await Promise.all([
      first.run("remember", record, "same-record", "first"),
      second.run("remember", record, "same-record", "first"),
      first.roll("same-roll", "first", random),
      second.roll("same-roll", "first", random),
      first.run(
        "update_memory",
        { markdown: "# 현재 생활\n\n사진전을 준비한다.", reason: "현재 생활" },
        "short",
        "first",
      ),
    ]);
    expect(left).toBe(right);
    expect(roll).toBe("5000");
    expect(replay).toBe("5000");
    expect(random).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await second.run("search_memory", { query: "차" }, "search", "next")),
    ).toHaveLength(1);
    expect(await first.context()).toContain("사진전을 준비한다");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("long-term fading and loss remove old details from recall and synchronize short-term Memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-loss-"));
  try {
    const memory = conversationMemory(root);
    const created = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
    )(
      await memory.run(
        "remember",
        {
          topic: "생일 약속",
          text: "상대의 생일은 3월 17일이다. 케이크를 준비하기로 했다.",
          summary: "생일에 케이크를 준비할 약속이 있다.",
          clarity: "clear",
          reason: "상대가 날짜를 알려 줬다.",
        },
        "learn",
        "first",
      ),
    );
    await memory.run(
      "update_memory",
      {
        markdown: "# 현재 생활\n\n상대의 생일은 3월 17일이다. 케이크를 준비하기로 했다.",
        reason: "현재 약속",
      },
      "short",
      "first",
    );
    await memory.roll("fading-roll", "later", () => 0.5);
    await expect(
      memory.run(
        "remember",
        {
          id: created.id,
          topic: "생일 약속",
          text: "",
          summary: "생일에 할 일이 있었다.",
          clarity: "faded",
          reason: "오래 떠올리지 않았다.",
          diceCall: "fading-roll",
        },
        "incomplete-fading",
        "later",
      ),
    ).rejects.toThrow("short-term");
    await memory.run(
      "remember",
      {
        id: created.id,
        topic: "생일 약속 3월 17일 케이크",
        text: "",
        summary: "생일에 할 일이 있었다.",
        clarity: "faded",
        reason: "3월 17일 케이크라는 세부 정보를 잊었다.",
        diceCall: "fading-roll",
        shortTerm: "# 현재 생활\n\n생일에 할 일이 있었지만 날짜와 세부 약속은 희미하다.",
      },
      "fade",
      "later",
    );
    const faded = await memory.run("search_memory", { query: "생일" }, "search-1", "later");
    expect(faded).toContain("생일에 할 일이 있었다");
    expect(faded).not.toContain("3월 17일");
    expect(faded).not.toContain("케이크");
    expect(await memory.context()).not.toContain("3월 17일");
    expect(await memory.run("search_memory", { query: "케이크" }, "lost-detail", "later")).toBe(
      "[]",
    );
    await memory.roll("forgetting-roll", "much-later", () => 0.9);
    await memory.run(
      "remember",
      {
        id: created.id,
        topic: "생일 약속",
        text: "",
        summary: "",
        clarity: "forgotten",
        reason: "다시 떠올리지 못했다.",
        diceCall: "forgetting-roll",
        shortTerm: "# 현재 생활\n\n사진전을 준비한다.",
      },
      "forget",
      "much-later",
    );
    expect(await memory.run("search_memory", { query: "생일" }, "search-1", "much-later")).toBe(
      "[]",
    );
    const context = await conversationMemory(root).context();
    expect(context).toContain("forgotten");
    expect(context).not.toContain("3월 17일");
    expect(context).not.toContain("케이크");
    expect(await readFile(join(root, "long-term", `${created.id}.md`), "utf8")).not.toContain(
      "3월 17일",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
