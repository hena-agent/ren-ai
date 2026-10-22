import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  personaMemory,
  readRuntime,
  runtimeFromDocuments,
  lockedMemory,
} from "@ren-ai/plugin-session-folder/memory";
import { writeScopedRuntime } from "../../../../packages/plugins/session-folder/src/memory-files.ts";
import {
  withPersona,
  readers,
  state,
  record,
  restoreMemory,
} from "../../test/memory.test-helper.ts";

test("independent trait activations compose while a stale overwrite returns the latest trait", () =>
  withPersona(async (root) => {
    const { a, b } = await readers(root);
    const traits = { shy: { strength: 70, active: true, persistence: "lasting" } };
    await a.run("update_state", { ...state({}), traits }, "shy", "source");
    await b.run(
      "update_state",
      { ...state({}), traits: { playful: { strength: 40, active: true, persistence: "lasting" } } },
      "playful",
      "source",
    );
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await b.run(
          "update_state",
          { ...state({}), traits: { shy: { ...traits.shy, strength: 90 } } },
          "stale",
          "source",
        ),
      ).toContain('"strength":70');
    } finally {
      log.mockRestore();
    }
    expect((await readRuntime(root))?.state?.traits).toMatchObject({
      shy: { strength: 70 },
      playful: { strength: 40 },
    });
    await expect(
      a.run(
        "update_state",
        { ...state({}), languageProficiency: { fr: "fluent" } },
        "skip-beginner",
        "source",
      ),
    ).rejects.toThrow("beginner");
  }));

test("a deleted shared Markdown record cannot be silently recreated by an earlier recalled edit", () =>
  withPersona(async (root) => {
    const { a } = await readers(root);
    await a.run("remember", record("life", "tea in the studio"), "new", "source");
    const id = (await readRuntime(root))!.longTerm[0]!.id;
    await rm(join(root, "long-term", `${id}.md`));
    const input = { ...record("life", "tea at home"), id };
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await a.run("remember", input, "deleted", "source")).toContain(
        "SHARED_MEMORY_CONFLICT",
      );
    } finally {
      log.mockRestore();
    }
    await expect(a.run("remember", input, "reconsidered", "source")).rejects.toThrow("not found");
    expect(await a.run("search_memory", { query: "tea" }, "search", "source")).toBe("[]");
  }));

test("runtime imports preserve Markdown provenance, reject invalid scope targets and replace operational checkpoints", () =>
  withPersona(async (root) => {
    const initial = runtimeFromDocuments(undefined);
    expect(initial).toEqual({ additional: {}, shortTerm: "", longTerm: [], receipts: {} });
    const documents = {
      state:
        "---\naffection: 25\nlastChange:\n  reason: Initial interest\n  source: a\n  at: 2026-10-20T00:00:00Z\n---\n",
      memory:
        "---\nchanges:\n  - reason: Started painting\n    source: a\n    at: 2026-10-20T00:00:00Z\n---\n\nI am painting.",
    };
    const imported = runtimeFromDocuments(documents);
    expect(imported.stateChange?.reason).toBe("Initial interest");
    expect(imported.shortTerm).toBe("I am painting.");
    const life = (await readRuntime(root))!;
    const scopes = { life, relationship: imported };
    await expect(
      lockedMemory(root, () => writeScopedRuntime(root, "../escape", scopes, scopes)),
    ).rejects.toThrow("Invalid Conversation key");
    await personaMemory(root, "sesa").context();
    const checkpoints = join(root, ".memory", "observations.json");
    expect(await readFile(checkpoints, "utf8")).not.toContain("I am painting");
    await writeFile(checkpoints, '{"sesa":{"shortTerm":42}}');
    await expect(personaMemory(root, "sesa").context()).rejects.toThrow("memory files");
    await rm(checkpoints);
    await personaMemory(root, "sesa").context();
    await restoreMemory(root, {
      ...life,
      shortTerm: imported.shortTerm,
      shortTermChanges: imported.shortTermChanges,
    });
    await expect(readFile(checkpoints, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await personaMemory(root, "sesa").context()).toContain("Started painting");
  }));
