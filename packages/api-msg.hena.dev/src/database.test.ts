import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { fakeGestures } from "./gestures/gestures.fake.ts";
import { noticeCopy } from "./onboarding/onboarding.ts";
import { startMessagingServer } from "./main.ts";
import { fakeMessages } from "./messages/messages.fake.ts";
import { silentAlerts } from "./opencode/scripted-overrides.test-helper.ts";

vi.mock("@effect/sql-sqlite-bun", async () => ({
  SqliteClient: { layer: (await import("@effect/sql-sqlite-node")).SqliteClient.layer },
}));

test("the production entry keeps a separate server database open for its host lifetime", async () => {
  const root = await mkdtemp(join(tmpdir(), "server-db-"));
  const personaDirectory = join(root, "content");
  await mkdir(personaDirectory);
  await writeFile(
    join(personaDirectory, "persona1.md"),
    "---\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: hi\nmemory: remember\n---\nPersona prompt\n",
  );
  const messages = fakeMessages();
  const ui = fakeGestures();
  expect(messages.events).toEqual([]);
  expect(ui.events).toEqual([]);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* startMessagingServer(
            join(root, "isolated"),
            {
              configDirectory: join(root, "config"),
              databasePath: ":memory:",
              personaDirectory,
              providers: {},
              model: "test/probe",
              health: { raise: () => Effect.void },
            },
            join(root, "server.sqlite"),
            messages.messages,
            ui.gestures,
            { turnstileSecret: "test-secret", notice: noticeCopy },
            silentAlerts,
          );
          const session = yield* host.createSession("persona1");
          const conversation = yield* host.conversations.create({
            handle: "hi@example.com",
            locale: "ko",
            consentVersion: "v1",
            consentLanguage: "ko",
            personaID: "persona1",
            sessionID: session.id,
          });
          expect((yield* host.conversations.bySession(session.id))?.handle).toBe(
            conversation.handle,
          );
        }),
      ),
    );
    expect((await stat(join(root, "server.sqlite"))).isFile()).toBe(true);
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ handle: string }>`SELECT handle FROM user`;
      }).pipe(Effect.provide(SqliteClient.layer({ filename: join(root, "server.sqlite") }))),
    );
    expect(rows).toEqual([{ handle: "hi@example.com" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
