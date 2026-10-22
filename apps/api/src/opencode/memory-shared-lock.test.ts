import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { restoreMemory, emptyMemory } from "../../test/memory.test-helper.ts";

type MemoryModule = typeof import("@ren-ai/plugin-session-folder/memory");
const bundle = Schema.Struct({
  lockedMemory: Schema.declare(
    (value): value is MemoryModule["lockedMemory"] => typeof value === "function",
  ),
  personaMemory: Schema.declare(
    (value): value is MemoryModule["personaMemory"] => typeof value === "function",
  ),
  readRuntime: Schema.declare(
    (value): value is MemoryModule["readRuntime"] => typeof value === "function",
  ),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("separately built production modules serialize the same persona's Markdown transactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-bundles-"));
  try {
    const entry = new URL(
      "../../../../packages/plugins/session-folder/src/memory.ts",
      import.meta.url,
    ).pathname;
    for (const name of ["context", "tools"])
      await promisify(execFile)("bun", [
        "build",
        entry,
        "--target=node",
        `--outfile=${join(root, `${name}.mjs`)}`,
      ]);
    const load = async (name: string) =>
      Schema.decodeUnknownSync(bundle)(await import(pathToFileURL(join(root, `${name}.mjs`)).href));
    const [context, tools] = await Promise.all([load("context"), load("tools")]);
    const gate = deferred();
    const entered = deferred();
    const order: string[] = [];
    const first = context.lockedMemory(root, async () => {
      entered.resolve();
      await gate.promise;
      order.push("first");
    });
    await entered.promise;
    const second = tools.lockedMemory(root, async () => {
      order.push("second");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    await mkdir(join(root, ".sessions"));
    await mkdir(join(root, "conversations", "a"), { recursive: true });
    await writeFile(join(root, "persona.json"), '{"id":"persona1"}');
    await writeFile(
      join(root, ".sessions", "sesa.json"),
      '{"personaID":"persona1","conversationKey":"a","writable":true}',
    );
    await restoreMemory(root, {
      ...emptyMemory,
      state: { mood: 50, energy: 60, stress: 20, connection: 40, solitude: 30, traits: {} },
    });
    await restoreMemory(join(root, "conversations", "a"), {
      ...emptyMemory,
      state: { affection: 25 },
    });
    await context.personaMemory(root, "sesa").context();
    expect(
      await tools
        .personaMemory(root, "sesa")
        .run(
          "update_state",
          { scores: { energy: 35 }, additions: {}, remove: [], reason: "Rest" },
          "call",
          "source",
        ),
    ).not.toContain("conflict");
    expect((await context.readRuntime(root))?.state?.energy).toBe(35);
    const restarted = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `
      const { personaMemory } = await import(${JSON.stringify(pathToFileURL(join(root, "tools.mjs")).href)});
      const memory = personaMemory(${JSON.stringify(root)}, "sesa");
      const input = { scores: { energy: 35 }, additions: {}, remove: [], reason: "Rest" };
      console.log(JSON.stringify([
        await memory.run("update_state", input, "call", "source"),
        await memory.run("update_state", { ...input, scores: { energy: 90 } }, "unread", "source")
      ]));
    `,
    ]);
    expect(restarted.stdout).toContain("Current State and Relationship state updated");
    expect(restarted.stdout).toContain("SHARED_MEMORY_CONFLICT");
    expect((await context.readRuntime(root))?.state?.energy).toBe(35);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
