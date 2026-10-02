import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, type Scope } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { FailureAlerts } from "../src/opencode/failed-turns.ts";

const quiet = () => Effect.void;
export const silentAlerts: FailureAlerts = { raise: quiet, clear: quiet };

export const messagingFixture = async (prefix: string, opening = "Hi") => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "persona1.md"),
    `---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: ${opening}\nmemory: Remember.\n---\nYou are Persona1.\n`,
  );
  return { root, personaDirectory };
};

export const registration = (handle: string, sessionID: string) => ({
  handle,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID: "persona1",
  sessionID,
});

export const runMessagingTest = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  filename = ":memory:",
) => Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(SqliteClient.layer({ filename })))));
