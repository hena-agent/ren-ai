import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test, vi } from "vitest";
import { migrate } from "./database.ts";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { startMessagingServer } from "../test/application.test-helper.ts";
import { silentAlerts } from "../test/messaging.test-helper.ts";

vi.mock("@effect/sql-sqlite-bun", async () => ({
  SqliteClient: { layer: (await import("@effect/sql-sqlite-node")).SqliteClient.layer },
}));

test("forward migration leaves exactly the PRD app tables", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migrate;
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
        WHERE type = 'table' ORDER BY name`;
      const names = rows.map((row) => row.name);
      expect(names.filter((name) => name.startsWith("sqlite_"))).toEqual(["sqlite_sequence"]);
      expect(names.filter((name) => name === "effect_sql_migrations")).toEqual([
        "effect_sql_migrations",
      ]);
      const appTables = names.filter(
        (name) => name !== "effect_sql_migrations" && !name.startsWith("sqlite_"),
      );
      expect(appTables).toEqual([
        "application_checkpoint",
        "application_clock",
        "application_work",
        "blocked",
        "bookmark",
        "catalog_plan",
        "context_seen",
        "conversation",
        "conversation_end",
        "conversation_recovery",
        "discovery_attempt",
        "discovery_contact",
        "discovery_language",
        "discovery_like",
        "discovery_notification",
        "discovery_profile",
        "discovery_registration",
        "discovery_selection",
        "discovery_verification",
        "ending_notification",
        "failed_turn",
        "follow_up",
        "intake_edit",
        "intake_handle",
        "intake_pending",
        "intake_seen",
        "notification_attempt",
        "persona_assignment",
        "persona_exclusion",
        "public_catalog",
        "recovery_scan",
        "removal",
        "reply_arrival",
        "reset",
        "retained_session",
        "runtime_catalog",
        "send",
        "test_handle",
        "usage_entry",
        "usage_session",
        "usage_turn",
        "user",
      ]);
      expect(appTables).not.toContain("intake_last");
      expect(
        (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('reset')`).map(
          (column) => column.name,
        ),
      ).not.toContain("notice_id");
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  );
});

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
