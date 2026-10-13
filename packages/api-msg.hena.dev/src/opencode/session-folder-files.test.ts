import * as fs from "node:fs/promises";
import { join } from "node:path";
import { folderFiles, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { managedFolder, sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { expect, test, vi } from "vitest";
import { messagingFixture } from "../../test/messaging.test-helper.ts";
import { conversationMemory } from "@ren-ai/plugin-session-folder/memory";
import { parseConversationState, serializeInitialState } from "@ren-ai/personas";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const snapshot = renderSnapshot(
  {
    id: "persona1",
    timeZone: "UTC",
    language: "en",
    openingLine: "Hi",
    memory: "Remember.",
    prompt: "Original.",
  },
  "Original rules.",
);
const withFiles = async (
  run: (files: ReturnType<typeof folderFiles>, directory: string) => Promise<void>,
) => {
  const { root, personaDirectory } = await messagingFixture("folder-files-");
  try {
    await run(folderFiles(personaDirectory), personaDirectory);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
};

test("new folder writes publish only complete snapshots and clean failed staging", () =>
  withFiles(async (files, directory) => {
    const write = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation((path, ...args) =>
      typeof path === "string" && path.endsWith("/next/AGENTS.md")
        ? Promise.reject(new Error("Disk unavailable"))
        : write(path, ...args),
    );
    await expect(files.write("ses_initial", snapshot)).rejects.toThrow("Disk unavailable");
    expect(await files.exists("ses_initial")).toBe(false);
    expect(await fs.readdir(join(directory, "sessions"))).toEqual([]);
  }));

test("failed live writes preserve every old snapshot file and unrelated files", () =>
  withFiles(async (files, directory) => {
    const target = await files.write("ses_update", snapshot);
    await fs.writeFile(join(target, "unrelated.txt"), "Keep me.");
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation((from, to) =>
      String(to) === join(target, "opencode.json")
        ? Promise.reject(new Error("Commit unavailable"))
        : rename(from, to),
    );
    await expect(
      files.write(
        "ses_update",
        renderSnapshot({ ...snapshot.persona, prompt: "Changed." }, "Changed rules."),
      ),
    ).rejects.toThrow("Commit unavailable");
    expect(await files.read("ses_update")).toEqual(snapshot);
    expect(await fs.readFile(join(target, "unrelated.txt"), "utf8")).toBe("Keep me.");
    expect(await fs.readdir(join(directory, "sessions"))).toEqual(["ses_update"]);
    await fs.rm(join(target, "AGENTS.md"));
    await expect(files.write("ses_update", snapshot)).rejects.toThrow("Commit unavailable");
    await expect(fs.stat(join(target, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(join(target, ".opencode", "agents", "persona1.md"), "utf8")).toBe(
      snapshot.agent,
    );
  }));

test("preflight read failures never publish part of an update and canonical paths reject unsafe IDs", () =>
  withFiles(async (files, directory) => {
    const target = await files.write("ses_read", snapshot);
    await fs.rm(join(target, "AGENTS.md"));
    await fs.mkdir(join(target, "AGENTS.md"));
    await expect(
      files.write(
        "ses_read",
        renderSnapshot({ ...snapshot.persona, prompt: "Must not leak." }, "New."),
      ),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(await fs.readFile(join(target, ".opencode", "agents", "persona1.md"), "utf8")).toBe(
      snapshot.agent,
    );
    expect(sessionDirectory(directory, "ses_read")).toBe(target);
    expect(managedFolder(directory, target)).toBe("ses_read");
    expect(managedFolder(directory, join(directory, "sessions", "not-a-session"))).toBeUndefined();
    expect(managedFolder(directory, directory)).toBeUndefined();
    expect(() => sessionDirectory(directory, "ses_../../escape")).toThrow(/Expected/);
  }));

test("initial Catalog documents seed new Conversations; updates and snapshot transfers preserve evolving documents", () =>
  withFiles(async (files) => {
    const initial = { state: "initial private State", memory: "initial private Memory" };
    const seeded = renderSnapshot({ ...snapshot.persona, initial }, snapshot.rules);
    const target = await files.write("ses_seeded", seeded);
    expect((await files.read("ses_seeded")).documents).toEqual(initial);
    await expect(
      files.write("ses_seeded", { ...seeded, persona: { ...seeded.persona, id: "different" } }),
    ).rejects.toThrow("persona cannot change");
    const current = { state: "current State", memory: "current Memory".repeat(2000) };
    await fs.writeFile(join(target, "STATE.md"), current.state);
    await fs.writeFile(join(target, "MEMORY.md"), current.memory);
    await files.write(
      "ses_seeded",
      renderSnapshot(
        { ...snapshot.persona, initial: { state: "new template", memory: "new template" } },
        "new rules",
      ),
    );
    const preserved = await files.read("ses_seeded");
    expect(preserved.documents).toEqual(current);
    await files.write("ses_restored", preserved);
    expect((await files.read("ses_restored")).documents).toEqual(current);
    const unbound = files.path("ses_unbound");
    await fs.mkdir(unbound);
    await fs.writeFile(join(unbound, "STATE.md"), current.state);
    await fs.writeFile(join(unbound, "MEMORY.md"), current.memory);
    await files.write("ses_unbound", seeded);
    expect((await files.read("ses_unbound")).documents).toEqual(current);
    await fs.rm(join(target, "STATE.md"));
    await expect(files.read("ses_seeded")).rejects.toThrow("both STATE.md and MEMORY.md");
    await fs.writeFile(join(target, "STATE.md"), current.state);
    await fs.rm(join(target, "MEMORY.md"));
    await expect(files.read("ses_seeded")).rejects.toThrow("both STATE.md and MEMORY.md");
    await fs.writeFile(join(target, "MEMORY.md"), current.memory);
    await fs.rm(join(target, "STATE.md"));
    await fs.mkdir(join(target, "STATE.md"));
    await expect(files.read("ses_seeded")).rejects.toMatchObject({ code: "EISDIR" });
  }));

test("starting affection seeds only new Conversations and never resets current or unspecified affection", () =>
  withFiles(async (files) => {
    const state = serializeInitialState({
      mood: 55,
      energy: 60,
      stress: 35,
      connection: 55,
      solitude: 60,
      affection: 27,
      traits: {},
    });
    const initial = { state, memory: "# 현재 생활\n\n사진전을 준비 중이다." };
    const seeded = renderSnapshot({ ...snapshot.persona, initial }, snapshot.rules);
    const path = await files.write("ses_affection", seeded);
    expect(
      parseConversationState((await files.read("ses_affection")).documents!.state).affection,
    ).toBe(27);
    const memory = conversationMemory(path);
    await memory.run(
      "update_state",
      {
        scores: { affection: 58 },
        additions: {},
        remove: [],
        reason: "대화를 나누며 조금 가까워졌다.",
      },
      "affection-update",
      "message-1",
    );
    const next = renderSnapshot(
      {
        ...snapshot.persona,
        initial: { ...initial, state: state.replace("affection: 27", "affection: 90") },
      },
      "new rules",
    );
    await files.write("ses_affection", next);
    const current = await files.read("ses_affection");
    expect(current.runtime?.state?.affection).toBe(58);
    expect(await memory.context()).toContain("affection: 58");
    await files.write("ses_new_affection", next);
    expect(
      parseConversationState((await files.read("ses_new_affection")).documents!.state).affection,
    ).toBe(90);
    await files.write("ses_restored_affection", current);
    expect((await files.read("ses_restored_affection")).runtime?.state?.affection).toBe(58);
    const prior = renderSnapshot(
      { ...snapshot.persona, initial: { ...initial, state: state.replace("affection: 27\n", "") } },
      snapshot.rules,
    );
    const oldPath = await files.write("ses_existing_affection", prior);
    const existing = conversationMemory(oldPath);
    await existing.run(
      "update_state",
      { scores: { stress: 20 }, additions: {}, remove: [], reason: "휴식을 취했다." },
      "condition-update",
      "message-2",
    );
    await files.write("ses_existing_affection", next);
    const preserved = (await files.read("ses_existing_affection")).runtime!.state!;
    expect(preserved).not.toHaveProperty("affection");
    expect(preserved.stress).toBe(20);
    for (const value of [-1, 101, 1.5])
      await expect(
        memory.run(
          "update_state",
          { scores: { affection: value }, additions: {}, remove: [], reason: "invalid" },
          `invalid-${value}`,
          "message-3",
        ),
      ).rejects.toThrow("tool input");
    await expect(
      memory.run(
        "update_state",
        {
          scores: {},
          additions: { affection: { value: 50, meaning: "호감도", reason: "중복" } },
          remove: [],
          reason: "중복 항목",
        },
        "duplicate-affection",
        "message-3",
      ),
    ).rejects.toThrow("built-in");
    expect((await files.read("ses_affection")).runtime?.state?.affection).toBe(58);
  }));
