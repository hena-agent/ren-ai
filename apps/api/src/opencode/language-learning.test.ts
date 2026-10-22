import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { personaMemory, readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { serializeInitialState } from "@ren-ai/personas";

test("learning is shared across Conversations while private learning experiences stay isolated through replay and Catalog edits", async () => {
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
    const directory = await files.write("sesFirst", renderSnapshot(persona, "Rules"), {
      conversationKey: "first",
    });
    expect(
      await files.write("sesSecond", renderSnapshot(persona, "Rules"), {
        conversationKey: "second",
      }),
    ).toBe(directory);
    const memory = personaMemory(directory, "sesFirst");
    const sibling = personaMemory(directory, "sesSecond");
    await memory.context();
    await memory.run(
      "remember",
      {
        scope: "life",
        topic: "영어 표현",
        text: "grab a coffee라는 표현은 커피를 마시러 간다는 뜻이다.",
        summary: "커피 마시러 가기",
        clarity: "clear",
        reason: "일상 영어 표현을 익혔다.",
      },
      "expression",
      "message-1",
    );
    await memory.run(
      "remember",
      {
        scope: "relationship",
        topic: "함께 영어 연습",
        text: "사용자가 토요일에 영어 표현을 설명해 줬다.",
        summary: "함께 연습한 기억",
        clarity: "clear",
        reason: "직접 함께 연습했다.",
      },
      "private-learning",
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
    await personaMemory(directory, "sesFirst").run("update_state", input, "learn", "message-20");
    expect((await readRuntime(directory))?.state?.languageProficiency).toEqual({
      ko: "fluent",
      en: "conversational",
      ja: "beginner",
    });
    expect(await memory.run("search_memory", { query: "grab" }, "search", "message-23")).toContain(
      "grab a coffee",
    );
    expect(await sibling.run("search_memory", { query: "grab" }, "search", "message-23")).toContain(
      "grab a coffee",
    );
    expect(
      await memory.run("search_memory", { query: "토요일" }, "private-search", "message-23"),
    ).toContain("토요일");
    expect(
      await sibling.run("search_memory", { query: "토요일" }, "private-search", "message-23"),
    ).toBe("[]");
    expect(await sibling.context()).toContain("en: conversational");
    await files.write(
      "sesFirst",
      renderSnapshot(
        { ...persona, initial: { ...persona.initial, state: state.replace("beginner", "fluent") } },
        "New rules",
      ),
    );
    expect((await files.read("sesFirst")).documents?.state).toContain("en: conversational");
    expect((await files.read("sesSecond")).documents?.state).toContain("en: conversational");
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
          scope: "life",
          additions: {
            languageProficiency: { value: "fluent", meaning: "override", reason: "test" },
          },
        },
        "override",
        "message-26",
      ),
    ).rejects.toThrow("built-in");
    expect((await readRuntime(directory))?.stateChange?.source).toBe("first");
    const unset = await files.write(
      "sesUnset",
      renderSnapshot(
        {
          ...persona,
          id: "unset",
          initial: {
            state: state.replace(/languageProficiency:[\s\S]*?(?=---)/, ""),
            memory: "# 현재 생활\n\n공부 중이다.",
          },
        },
        "Rules",
      ),
    );
    const learner = personaMemory(unset, "sesUnset");
    await learner.context();
    await learner.run(
      "update_state",
      { ...input, languageProficiency: { en: "beginner" } },
      "start",
      "message",
    );
    expect((await readRuntime(unset))?.state?.languageProficiency).toEqual({ en: "beginner" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
