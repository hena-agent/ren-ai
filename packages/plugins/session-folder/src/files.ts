import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import type { Persona } from "@ren-ai/personas";
import { folderSnapshot } from "./protocol.ts";
import { sessionDirectory } from "./paths.ts";

export const personaPermissions = [
  { action: "*", resource: "*", effect: "deny" as const },
  ...["send", "read", "react", "wait"].map((action) => ({
    action,
    resource: "*",
    effect: "allow" as const,
  })),
];

export const loadGroundRules = () =>
  readFile(new URL("../templates/ground-rules.md", import.meta.url), "utf8");

export const renderSnapshot = (persona: Persona, rules: string): typeof folderSnapshot.Type => ({
  persona,
  rules,
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
    return {
      persona,
      agent: await readFile(join(target, ".opencode", "agents", `${persona.id}.md`), "utf8"),
      rules: await readFile(join(target, "AGENTS.md"), "utf8"),
    };
  };
  return {
    path,
    exists: async (folderID: string) => (await lstat(path(folderID)).catch(absent)) !== undefined,
    read,
    remove: (folderID: string) => rm(path(folderID), { recursive: true, force: true }),
    write: async (folderID: string, snapshot: typeof folderSnapshot.Type) => {
      const target = path(folderID);
      await directory(join(root, "sessions"));
      const prior = await readFile(join(target, "persona.json"), "utf8").catch(absent);
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
      ]);
      return target;
    },
  };
};
