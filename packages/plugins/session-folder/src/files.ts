import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { Persona } from "@ren-ai/personas";
import {
  folderSnapshot,
  personaFolderSnapshot,
  conversationKey,
  folderID,
  personaID as personaIdentifier,
} from "./protocol.ts";
import { personaDirectory, sessionDirectory } from "./paths.ts";
import { runtimeDocuments, memoryToolNames } from "./memory.ts";
import { lockedMemory, readRuntime, readMemoryDocuments } from "./memory-files.ts";
import {
  locateBinding,
  readSessionBinding,
  writeSessionBinding,
  removeSessionBinding,
} from "./bindings.ts";
import { isDeepStrictEqual } from "node:util";
import { initializeDirectory, initializeLife, initializeRelationship } from "./initialization.ts";
import { readAdjustments } from "./adjustments.ts";
import { emptyAdjustments } from "./adjustment-model.ts";

export const personaPermissions = [
  { action: "*", resource: "*", effect: "deny" as const },
  ...[
    "send",
    "take_photo",
    "send_photo",
    "read",
    "react",
    "wait",
    "end_conversation",
    "dice",
    "review_adjustments",
    "websearch",
    ...memoryToolNames,
  ].map((action) => ({
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
    ...(persona.version !== undefined && { version: persona.version }),
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
  if (!stat.isDirectory()) throw new Error("Session folder must be a real directory");
};

const absent = (error: Error & { code?: string }) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
};

const entries = async (target: string) => {
  const stat = await lstat(target).catch(absent);
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Error("Persona inventory requires real directories");
  return (await readdir(target)).filter((name) => !name.startsWith(".")).toSorted();
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

const readAt = async (target: string) => {
  const runtime = await readRuntime(target);
  const persona = Schema.decodeUnknownSync(folderSnapshot.fields.persona)(
    JSON.parse(await readFile(join(target, "persona.json"), "utf8")),
  );
  const documents = runtime ? runtimeDocuments(runtime) : await readDocuments(target);
  const adjustments = await readAdjustments(target);
  return {
    persona,
    agent: await readFile(join(target, ".opencode", "agents", `${persona.id}.md`), "utf8"),
    rules: await readFile(join(target, "AGENTS.md"), "utf8"),
    ...(documents && { documents }),
    ...(runtime && { runtime }),
    ...(adjustments && { adjustments }),
  };
};
const writeAt = async (target: string, snapshot: typeof folderSnapshot.Type) => {
  await directory(dirname(target));
  const prior = await readFile(join(target, "persona.json"), "utf8").catch(absent);
  const previous = prior
    ? Schema.decodeUnknownSync(folderSnapshot.fields.persona)(JSON.parse(prior))
    : undefined;
  if (previous && previous.id !== snapshot.persona.id)
    throw new Error("A session's persona cannot change");
  if ((previous?.version ?? 0) > (snapshot.persona.version ?? 0))
    throw new Error("A session's Persona version cannot go backwards; restore as a new version");
  const contents = [
    [join(".opencode", "agents", `${snapshot.persona.id}.md`), snapshot.agent],
    ["AGENTS.md", snapshot.rules],
    ["persona.json", JSON.stringify(snapshot.persona)],
    [
      "opencode.json",
      JSON.stringify({
        default_agent: snapshot.persona.id,
        websearch: { provider: "random" },
        agents: Object.fromEntries(
          ["build", "plan", "general", "explore"].map((id) => [id, { disabled: true }]),
        ),
      }),
    ],
  ] as const;
  if (prior) await publish(target, contents);
  else {
    if (await lstat(target).catch(absent))
      throw new Error("Persona folder already exists without a complete snapshot");
    await initializeDirectory(target, async (stage) => {
      await publish(stage, contents);
      await initializeLife(stage, snapshot);
    });
  }
  return target;
};

async function checkRelationships(target: string, archive: typeof personaFolderSnapshot.Type) {
  for (const [key, runtime] of Object.entries(archive.relationships)) {
    const relation = join(target, "conversations", Schema.decodeUnknownSync(conversationKey)(key));
    if (await lstat(relation).catch(absent)) {
      const current = (await readRuntime(relation)) ?? (await readMemoryDocuments(relation));
      if (!isDeepStrictEqual(current, runtime))
        throw new Error("Restore conflicts with existing Relationship scope");
    }
  }
}

export const folderFiles = (root: string) => {
  const path = (id: string) => personaDirectory(root, id);
  const locate = async (id: string) => {
    const binding = await locateBinding(root, id);
    if (!binding) throw new Error("Session has no managed binding");
    return binding;
  };
  const read = async (id: string) => {
    const found = await locate(id);
    return lockedMemory(found.directory, async () => {
      const binding = await readSessionBinding(found.directory, id);
      const relationshipPath = join(found.directory, "conversations", binding.conversationKey);
      return {
        ...(await readAt(found.directory)),
        binding,
        relationship:
          (await readRuntime(relationshipPath)) ?? (await readMemoryDocuments(relationshipPath)),
      };
    });
  };
  const write = async (
    id: string,
    snapshot: typeof folderSnapshot.Type,
    options?: { conversationKey?: string; writable?: boolean; sandbox?: boolean },
  ) => {
    const target = options?.sandbox ? sessionDirectory(root, id) : path(snapshot.persona.id);
    return lockedMemory(target, async () => {
      if (snapshot.binding && snapshot.binding.personaID !== snapshot.persona.id)
        throw new Error("Snapshot persona binding does not match");
      const prior = await locateBinding(root, id);
      const key = Schema.decodeUnknownSync(conversationKey)(
        options?.conversationKey ??
          snapshot.binding?.conversationKey ??
          prior?.conversationKey ??
          randomUUID(),
      );
      if (prior && (prior.directory !== target || prior.conversationKey !== key))
        throw new Error("Session binding cannot change");
      await writeAt(target, snapshot);
      const relation = join(target, "conversations", key);
      if (!(await lstat(relation).catch(absent))) {
        await initializeRelationship(relation, snapshot);
      }
      await writeSessionBinding(
        root,
        target,
        id,
        {
          personaID: snapshot.persona.id,
          conversationKey: key,
          writable: options?.writable ?? snapshot.binding?.writable ?? prior?.writable ?? true,
        },
        options?.sandbox ?? false,
      );
      return target;
    });
  };
  const snapshotRoot = (target: string, sandboxID?: string) =>
    lockedMemory(target, async () => {
      // Recover the root WAL before reading Relationship scopes from the same commit.
      const snapshot = await readAt(target);
      if (!sandboxID && target !== path(snapshot.persona.id))
        throw new Error("Persona directory does not match its snapshot");
      const bindings = Object.fromEntries(
        await Promise.all(
          (await entries(join(target, ".sessions"))).map(async (file) => {
            const id = Schema.decodeUnknownSync(folderID)(file.replace(/\.json$/, ""));
            if (file !== `${id}.json`) throw new Error("Expected session binding JSON files");
            const binding = await readSessionBinding(target, id);
            const found = await locate(id);
            if (
              found.directory !== target ||
              found.conversationKey !== binding.conversationKey ||
              found.writable !== binding.writable
            )
              throw new Error("Session location does not match its durable persona scope");
            return [id, binding] as const;
          }),
        ),
      );
      const relationships = Object.fromEntries(
        await Promise.all(
          (await entries(join(target, "conversations"))).map(async (key) => {
            Schema.decodeUnknownSync(conversationKey)(key);
            const relation = join(target, "conversations", key);
            return [
              key,
              (await readRuntime(relation)) ?? (await readMemoryDocuments(relation)),
            ] as const;
          }),
        ),
      );
      for (const binding of Object.values(bindings))
        if (!relationships[binding.conversationKey])
          throw new Error("Session binding has no Relationship scope");
      return { snapshot, bindings, relationships, ...(sandboxID && { sandboxID }) };
    });
  return {
    path,
    locate,
    read,
    write,
    exists: async (id: string) => (await locateBinding(root, id)) !== undefined,
    readAt: (target: string) => lockedMemory(target, () => readAt(target)),
    snapshot: async (id: string) => {
      const found = await locate(id);
      const snapshot = await snapshotRoot(found.directory, found.sandbox ? id : undefined);
      if (!snapshot.bindings[id]) throw new Error("Snapshot has no session binding");
      return snapshot;
    },
    inventory: async () => {
      const snapshots: Array<typeof personaFolderSnapshot.Type> = [];
      for (const kind of ["personas", "sandboxes"] as const) {
        const parent = join(root, kind);
        for (const name of await entries(parent)) {
          Schema.decodeUnknownSync(kind === "personas" ? personaIdentifier : folderID)(name);
          snapshots.push(
            await snapshotRoot(join(parent, name), kind === "sandboxes" ? name : undefined),
          );
        }
      }
      return snapshots;
    },
    restore: async (archive: typeof personaFolderSnapshot.Type) => {
      const target = archive.sandboxID
        ? sessionDirectory(root, archive.sandboxID)
        : path(archive.snapshot.persona.id);
      return lockedMemory(target, async () => {
        const exists = await lstat(target).catch(absent);
        if (exists) {
          const existing = await readAt(target);
          const expected = {
            adjustments: emptyAdjustments(),
            ...archive.snapshot,
            ...(archive.snapshot.runtime && {
              documents: runtimeDocuments(archive.snapshot.runtime),
            }),
          };
          if (!isDeepStrictEqual(existing, expected))
            throw new Error("Restore conflicts with existing persona scope");
        }
        await checkRelationships(target, archive);
        for (const [id, binding] of Object.entries(archive.bindings)) {
          if (
            binding.personaID !== archive.snapshot.persona.id ||
            !archive.relationships[binding.conversationKey]
          )
            throw new Error("Invalid archived session binding");
          const prior = await locateBinding(root, id);
          if (
            prior &&
            (prior.directory !== target ||
              prior.conversationKey !== binding.conversationKey ||
              prior.writable !== binding.writable)
          )
            throw new Error("Restore binding already exists");
        }
        if (!exists) await writeAt(target, archive.snapshot);
        for (const [key, runtime] of Object.entries(archive.relationships)) {
          const relation = join(
            target,
            "conversations",
            Schema.decodeUnknownSync(conversationKey)(key),
          );
          if (!(await lstat(relation).catch(absent))) {
            await initializeRelationship(relation, { ...archive.snapshot, relationship: runtime });
          }
        }
        for (const [id, binding] of Object.entries(archive.bindings)) {
          await writeSessionBinding(root, target, id, binding, archive.sandboxID !== undefined);
        }
        return target;
      });
    },
    update: async (id: string, snapshot: typeof folderSnapshot.Type) => {
      const found = await locate(id);
      return lockedMemory(found.directory, async () => {
        await readSessionBinding(found.directory, id);
        return writeAt(found.directory, snapshot);
      });
    },
    writable: async (id: string, writable: boolean) => {
      const found = await locate(id);
      return lockedMemory(found.directory, async () => {
        const binding = await readSessionBinding(found.directory, id);
        await writeSessionBinding(
          root,
          found.directory,
          id,
          { ...binding, writable },
          found.sandbox,
        );
      });
    },
    remove: async (id: string) => {
      const found = await locateBinding(root, id);
      if (found)
        await lockedMemory(found.directory, () => removeSessionBinding(root, found.directory, id));
    },
    removeRelationship: (personaID: string, key: string) => {
      const target = path(personaID);
      const checked = Schema.decodeUnknownSync(conversationKey)(key);
      return lockedMemory(target, () =>
        rm(join(target, "conversations", checked), { recursive: true, force: true }),
      );
    },
  };
};
