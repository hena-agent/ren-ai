import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { startPersonaHost } from "../main.ts";

test("a host cannot silently fall back to the Mac database", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-host-db-"));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "persona1.md"),
    "---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: 안녕\nmemory: Remember.\n---\nYou are Persona1.\n",
  );
  try {
    await expect(
      Effect.runPromise(
        Effect.scoped(
          startPersonaHost(join(root, "isolated"), {
            configDirectory: join(root, "private", "config"),
            databasePath: join(root, "missing-parent", "database.sqlite"),
            personaDirectory,
            providers: {},
            model: "test/probe",
            handleForSession: () => Effect.succeed(undefined),
          }),
        ),
      ),
    ).rejects.toThrow(/sqlite|open|database/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
