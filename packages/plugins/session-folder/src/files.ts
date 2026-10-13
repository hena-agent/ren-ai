import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { Persona } from "@ren-ai/personas";
import { folderSnapshot } from "./protocol.ts";
import { sessionDirectory } from "./paths.ts";
import { conversationMemory, readRuntime, runtimeDocuments, memoryToolNames } from "./memory.ts";
import { lockedMemory } from "./memory-files.ts";

export const personaPermissions = [
  { action: "*", resource: "*", effect: "deny" as const },
  ...["send", "read", "react", "wait", "dice", ...memoryToolNames].map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  })),
];

export const loadGroundRules = () =>
  readFile(new URL("../templates/ground-rules.md", import.meta.url), "utf8");

export const renderSnapshot = (persona: Persona, rules: string): typeof folderSnapshot.Type => ({
  persona: {
    id: persona.id,
    timeZone: persona.timeZone,
    language: persona.language,
    openingLine: persona.openingLine,
    memory: persona.memory,
    prompt: persona.prompt,
  },
  rules,
  ...(persona.initial && { documents: persona.initial }),
  agent: `---\ndescription: ${JSON.stringify(persona.openingLine)}\nmode: primary\npermissions: ${JSON.stringify(personaPermissions)}\n---\n${persona.prompt}`,
});

const directory = async (path: string) => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Session folder must be a real directory");
};

const absent = (error: Error & { code?: string }) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};

async function readDocuments(target: string) {
  const [state, memory] = await Promise.all([
    readFile(join(target, "STATE.md"), "utf8").catch(absent),
    readFile(join(target, "MEMORY.md"), "utf8").catch(absent),
  ]);
  if (state === undefined && memory === undefined) return undefined;
  if (state === undefined || memory === undefined)
    throw new Error("Conversation documents must include both STATE.md and MEMORY.md");
  return { state, memory };
}

const publish = async (target: string, contents: ReadonlyArray<readonly [string, string]>) => {
  const existing = await lstat(target).catch(absent);
  if (existing) {
    await directory(target);
    await directory(join(target, ".opencode"));
    await directory(join(target, ".opencode", "agents"));
  }
  const stage = join(dirname(target), `.${randomUUID()}.tmp`);
  const originals = new Map<string, string | undefined>();
  const committed: string[] = [];
  try {
    for (const [name, text] of contents) {
      const original = existing
        ? await readFile(join(target, name), "utf8").catch(absent)
        : undefined;
      originals.set(name, original);
      const staged = join(stage, "next", name);
      await directory(dirname(staged));
      await writeFile(staged, text, { flag: "wx", mode: 0o600 });
      if (original !== undefined) {
        const backup = join(stage, "prior", name);
        await directory(dirname(backup));
        await writeFile(backup, original, { flag: "wx", mode: 0o600 });
      }
    }
    if (!existing) {
      await rename(join(stage, "next"), target);
      return;
    }
    try {
      for (const [name] of contents) {
        await rename(join(stage, "next", name), join(target, name));
        committed.push(name);
      }
    } catch (error) {
      for (const name of committed.toReversed()) {
        if (originals.get(name) === undefined) await rm(join(target, name), { force: true });
        else await rename(join(stage, "prior", name), join(target, name));
      }
      throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

export const folderFiles = (root: string) => {
  const path = (folderID: string) => sessionDirectory(root, folderID);
  const read = async (folderID: string) => {
    const target = path(folderID);
    const persona = Schema.decodeUnknownSync(folderSnapshot.fields.persona)(
      JSON.parse(await readFile(join(target, "persona.json"), "utf8")),
    );
    const runtime = await readRuntime(target);
    const documents = runtime ? runtimeDocuments(runtime) : await readDocuments(target);
    return {
      persona,
      agent: await readFile(join(target, ".opencode", "agents", `${persona.id}.md`), "utf8"),
      rules: await readFile(join(target, "AGENTS.md"), "utf8"),
      ...(documents && { documents }),
      ...(runtime && { runtime }),
    };
  };
  return {
    path,
    exists: async (folderID: string) => (await lstat(path(folderID)).catch(absent)) !== undefined,
    read,
    remove: (folderID: string) =>
      lockedMemory(path(folderID), () => rm(path(folderID), { recursive: true, force: true })),
    write: async (folderID: string, snapshot: typeof folderSnapshot.Type) => {
      const target = path(folderID);
      await directory(join(root, "sessions"));
      const prior = await readFile(join(target, "persona.json"), "utf8").catch(absent);
      const existingDocuments = snapshot.documents ? await readDocuments(target) : undefined;
      if (
        prior &&
        Schema.decodeUnknownSync(folderSnapshot.fields.persona)(JSON.parse(prior)).id !==
          snapshot.persona.id
      )
        throw new Error("A session's persona cannot change");
      await publish(target, [
        [join(".opencode", "agents", `${snapshot.persona.id}.md`), snapshot.agent],
        ["AGENTS.md", snapshot.rules],
        ["persona.json", JSON.stringify(snapshot.persona)],
        [
          "opencode.json",
          JSON.stringify({
            default_agent: snapshot.persona.id,
            agents: Object.fromEntries(
              ["build", "plan", "general", "explore"].map((id) => [id, { disabled: true }]),
            ),
          }),
        ],
        ...(!prior && !existingDocuments && snapshot.documents
          ? ([
              ["STATE.md", snapshot.documents.state],
              ["MEMORY.md", snapshot.documents.memory],
            ] as const)
          : []),
      ]);
      if (!prior && snapshot.runtime) await conversationMemory(target).restore(snapshot.runtime);
      return target;
    },
  };
};
