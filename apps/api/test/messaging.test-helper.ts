import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, type Scope } from "effect";
import type { SqlClient } from "effect/sql";
import type { FailureAlerts } from "../src/opencode/failed-turns.ts";

const quiet = () => Effect.void;
export const silentAlerts: FailureAlerts = { raise: quiet, clear: quiet };

export const messagingFixture = async (prefix: string, opening = "Hi", personaCount = 1) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  for (let index = 1; index <= personaCount; index++)
    await writeFile(
      join(personaDirectory, `persona${index}.md`),
      `---\nname: 수아\npublished: true\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: ${opening}\nmemory: Remember.\n---\nYou are Persona${index}.\n\n## 공개 프로필\n\n24살 대학생\n`,
    );
  return { root, personaDirectory };
};

export const registration = (handle: string, sessionID: string, personaID = "persona1") => ({
  handle,
  locale: "ko",
  consentVersion: "v1",
  consentLanguage: "ko",
  personaID,
  sessionID,
});

export const runMessagingTest = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  filename = ":memory:",
) => Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(SqliteClient.layer({ filename })))));
