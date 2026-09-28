import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Result } from "effect";
import { expect, test } from "vitest";
import { loadPersonas } from "./personas.ts";

const valid = [
  "---",
  "time-zone: Asia/Seoul",
  "language: ko",
  "opening-line: 번호 받았으니까 먼저 연락해 봐",
  "memory: Remember his name.",
  "---",
  "You are Persona1. Speak Korean.",
  "",
].join("\n");

test("persona files fail closed on missing, extra, malformed and empty fields", async () => {
  const empty = await mkdtemp(join(tmpdir(), "empty-personas-"));
  try {
    await expect(Effect.runPromise(loadPersonas(empty))).rejects.toThrow(/No persona files/);
    const load = async (source: string) => {
      await writeFile(join(empty, "persona1.md"), source);
      return Effect.runPromise(loadPersonas(empty));
    };
    expect((await load(valid)).get("persona1")?.timeZone).toBe("Asia/Seoul");
    await expect(load(valid.replace("language: ko\n", ""))).rejects.toThrow(
      /persona1[\s\S]*language/,
    );
    const failed = await Effect.runPromiseExit(loadPersonas(empty));
    if (!Exit.isFailure(failed)) throw new Error("Expected invalid persona to fail");
    const defect = Cause.findDefect(failed.cause);
    if (!Result.isSuccess(defect) || !(defect.success instanceof Error)) {
      throw new Error("Expected a schema error");
    }
    expect(defect.success.cause).toBeInstanceOf(Error);
    await expect(load(valid.replace("language: ko", "language: ko\nunsafe: yes"))).rejects.toThrow(
      /persona1[\s\S]*unsafe/,
    );
    await expect(load(valid.replace("language: ko", "language: ko\nlanguage: en"))).rejects.toThrow(
      /persona1.*unique|persona1.*already defined/i,
    );
    await expect(load(valid.replace("Asia/Seoul", "Not/AZone"))).rejects.toThrow(
      /invalid time-zone: Not\/AZone/,
    );
    await expect(load(valid.replace("memory: Remember his name.", "memory: ''"))).rejects.toThrow(
      /must not be empty/,
    );
    await expect(load(valid.replace("language: ko", "language: '  '"))).rejects.toThrow(
      /must not be empty/,
    );
    await expect(load(valid.replace("You are Persona1. Speak Korean.", ""))).rejects.toThrow(
      /must not be empty/,
    );
    await expect(load("no frontmatter")).rejects.toThrow(/expected YAML frontmatter/);
    await expect(load(`prefix\n${valid}`)).rejects.toThrow(/expected YAML frontmatter/);
    await expect(load(valid.replace("language: ko", "unexpected: ko"))).rejects.toThrow(
      /persona1[\s\S]*unexpected/,
    );
    await writeFile(join(empty, "ignore.txt"), "not a persona");
    expect((await load(valid)).size).toBe(1);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
