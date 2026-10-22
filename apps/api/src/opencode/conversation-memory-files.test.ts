import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { readRuntime } from "@ren-ai/plugin-session-folder/memory";
import { memoryFixture } from "../../test/memory.test-helper.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

test("an interrupted paired memory change recovers before concurrent readers and never rerolls", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "memory-interrupted-"));
  const rename = fs.rename;
  try {
    const memory = await memoryFixture(root);
    await memory.run(
      "remember",
      {
        scope: "life",
        topic: "생일",
        text: "private-birthday-0317",
        summary: "생일 약속",
        clarity: "clear",
        reason: "직접 들었다.",
      },
      "learn",
      "first",
    );
    await memory.roll("decision", "later", () => 0.5);
    const before = (await readRuntime(root))!;
    const next = {
      id: before.longTerm[0]!.id,
      scope: "life",
      topic: "생일",
      text: "",
      summary: "생일 약속이 있었다.",
      clarity: "faded",
      reason: "세부 사항이 희미해졌다.",
      diceCall: "decision",
      shortTerm: "# 현재 생활\n\n생일 날짜가 기억나지 않는다.",
    };
    const failing = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("/.memory/receipts.json")) throw new Error("Storage interrupted");
      await rename(from, to);
    });
    await expect(memory.run("remember", next, "fade", "later")).rejects.toThrow(
      "Storage interrupted",
    );
    expect(await fs.readdir(join(root, ".memory"))).toContain("pending.json");
    failing.mockRestore();
    const restarted = await memoryFixture(root);
    const [context, search, receipt] = await Promise.all([
      restarted.context(),
      restarted.run("search_memory", { query: "생일" }, "search", "next"),
      restarted.run("remember", next, "fade", "later"),
    ]);
    expect(context).toContain("생일 날짜가 기억나지 않는다");
    expect(search).toContain("생일 약속이 있었다");
    expect(context + search).not.toContain("private-birthday-0317");
    expect(receipt).toContain('"clarity":"faded"');
    const random = vi.fn<() => number>(() => 0.9);
    expect(await restarted.roll("decision", "next", random)).toBe("5000");
    expect(random).not.toHaveBeenCalled();
    expect(await fs.readdir(join(root, ".memory"))).toEqual(["observations.json", "receipts.json"]);
    await restarted.restore({ ...before, longTerm: [] });
    expect(await fs.readdir(join(root, "long-term"))).toEqual([]);
    expect(await restarted.run("search_memory", { query: "생일" }, "search", "next")).toBe("[]");
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("invalid pending writes cannot escape the Conversation directory or overwrite its documents", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "memory-pending-validation-"));
  try {
    const memory = await memoryFixture(root);
    await memory.roll("create", "first", () => 0);
    const pending = join(root, ".memory", "pending.json");
    const original = await fs.readFile(join(root, "MEMORY.md"), "utf8");
    for (const invalid of [
      "not JSON: private",
      JSON.stringify([{ name: "../escaped.md", text: "private" }]),
      JSON.stringify([{ name: "MEMORY.md", text: "private", extra: true }]),
    ]) {
      await fs.writeFile(pending, invalid);
      await expect(memory.context()).rejects.toThrow("Invalid pending");
      expect(await fs.readFile(join(root, "MEMORY.md"), "utf8")).toBe(original);
    }
    await fs.rm(pending);
    await fs.writeFile(join(root, ".memory", "write.tmp"), "interrupted private write");
    expect(await memory.context()).toContain("current-state");
    expect(await fs.readdir(join(root, ".memory"))).toEqual(["observations.json", "receipts.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Markdown validation rejects malformed state and long-term records rather than substituting hidden copies", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "memory-markdown-validation-"));
  try {
    const memory = await memoryFixture(root);
    await memory.run(
      "remember",
      {
        scope: "life",
        topic: "취향",
        text: "차를 좋아한다.",
        summary: "차 취향",
        clarity: "clear",
        reason: "직접 들었다.",
      },
      "learn",
      "first",
    );
    const current = (await readRuntime(root))!;
    const statePath = join(root, "STATE.md");
    const state = await fs.readFile(statePath, "utf8");
    for (const invalid of ["---\nadditional: [\n---\n", `${state}\nprivate body`]) {
      await fs.writeFile(statePath, invalid);
      await expect(memory.context()).rejects.toThrow("memory files");
    }
    await fs.writeFile(statePath, state);
    const id = current.longTerm[0]!.id;
    const path = join(root, "long-term", `${id}.md`);
    const record = await fs.readFile(path, "utf8");
    for (const invalid of ["invalid private body", record.replace(id, "mismatched")]) {
      await fs.writeFile(path, invalid);
      await expect(memory.run("search_memory", { query: "차" }, "search", "next")).rejects.toThrow(
        "memory files",
      );
    }
    await fs.writeFile(path, record.replace(/^summary:.*\n/m, ""));
    expect((await readRuntime(root))!.longTerm[0]!.summary).toBe("");
    const extra = join(root, "long-term", "notes.txt");
    await fs.writeFile(extra, record);
    await expect(memory.context()).rejects.toThrow("memory files");
    await fs.rm(extra);
    const wrongExtension = join(root, "long-term", "record");
    await fs.writeFile(wrongExtension, record);
    await expect(memory.context()).rejects.toThrow("memory files");
    await fs.rm(wrongExtension);
    expect(await memory.run("search_memory", { query: "차" }, "search", "next")).toContain(
      "차를 좋아한다",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
