import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { conversationMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { serializeInitialState } from "@ren-ai/personas";

test("learning persists per Conversation, preserves sibling languages and survives replay and Catalog edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "language-learning-"));
  try {
    const files = folderFiles(root);
    const state = serializeInitialState({
      mood: 55,
      energy: 60,
      stress: 30,
      connection: 50,
      solitude: 60,
      affection: 12,
      traits: {},
      languageProficiency: { ko: "fluent", en: "beginner" },
    });
    const persona = {
      id: "harin",
      language: "ko",
      timeZone: "Asia/Seoul",
      openingLine: "Say hi",
      memory: "Remember",
      prompt: "You are Harin",
      initial: { state, memory: "# 현재 생활\n\n영어를 배우고 있다." },
    };
    await files.write("sesFirst", renderSnapshot(persona, "Rules"));
    await files.write("sesSecond", renderSnapshot(persona, "Rules"));
    const memory = conversationMemory(files.path("sesFirst"));
    await memory.run(
      "remember",
      {
        topic: "영어 표현",
        text: "사용자가 grab a coffee라는 표현을 알려줬다.",
        summary: "커피 마시러 가기",
        clarity: "clear",
        reason: "직접 설명해 줬다.",
      },
      "expression",
      "message-1",
    );
    const input = {
      scores: {},
      languageProficiency: { en: "conversational" },
      additions: {},
      remove: [],
      reason: "여러 날 카페 주문과 일상 이야기를 영어로 연습해 직접 사용할 수 있게 됐다.",
    };
    await memory.run("update_state", input, "learn", "message-20");
    await memory.run(
      "update_state",
      { ...input, languageProficiency: { ja: "beginner" } },
      "new-language",
      "message-21",
    );
    await memory.run(
      "update_state",
      { scores: { energy: 25 }, additions: {}, remove: [], reason: "피곤하다." },
      "tired",
      "message-22",
    );
    await conversationMemory(files.path("sesFirst")).run(
      "update_state",
      input,
      "learn",
      "message-20",
    );
    expect((await readRuntime(files.path("sesFirst")))?.state?.languageProficiency).toEqual({
      ko: "fluent",
      en: "conversational",
      ja: "beginner",
    });
    expect(await memory.run("search_memory", { query: "grab" }, "search", "message-23")).toContain(
      "grab a coffee",
    );
    await files.write(
      "sesFirst",
      renderSnapshot(
        { ...persona, initial: { ...persona.initial, state: state.replace("beginner", "fluent") } },
        "New rules",
      ),
    );
    expect((await files.read("sesFirst")).documents?.state).toContain("en: conversational");
    expect((await files.read("sesSecond")).documents?.state).toContain("en: beginner");
    await expect(
      memory.run(
        "update_state",
        { ...input, languageProficiency: { fr: "fluent" } },
        "jump",
        "message-24",
      ),
    ).rejects.toThrow("beginner");
    await expect(
      memory.run(
        "update_state",
        { ...input, languageProficiency: { en: "native" } },
        "native",
        "message-25",
      ),
    ).rejects.toThrow("Invalid");
    await expect(
      memory.run(
        "update_state",
        {
          ...input,
          additions: {
            languageProficiency: { value: "fluent", meaning: "override", reason: "test" },
          },
        },
        "override",
        "message-26",
      ),
    ).rejects.toThrow("built-in");
    expect((await readRuntime(files.path("sesFirst")))?.stateChange?.source).toBe("message-22");
    const unset = await mkdtemp(join(tmpdir(), "language-unset-"));
    try {
      await writeFile(
        join(unset, "STATE.md"),
        state.replace(/languageProficiency:[\s\S]*?(?=---)/, ""),
      );
      await writeFile(join(unset, "MEMORY.md"), "# 현재 생활\n\n공부 중이다.");
      await conversationMemory(unset).run(
        "update_state",
        { ...input, languageProficiency: { en: "beginner" } },
        "start",
        "message",
      );
      expect((await readRuntime(unset))?.state?.languageProficiency).toEqual({ en: "beginner" });
    } finally {
      await rm(unset, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
