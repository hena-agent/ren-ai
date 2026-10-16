import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Logger } from "effect";
import { expect, test } from "vitest";
import { MessageMetadata, messageMetadata } from "./message-metadata.ts";
import { makeImsgMessages } from "./imsg.ts";
import { fixture } from "./imsg.fake.ts";

test("cold status reads use indexed metadata, including backdated outgoing rows and database replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "imsg-metadata-"));
  const path = join(root, "chat.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE chat (chat_identifier TEXT);
      CREATE INDEX chat_handle ON chat(chat_identifier);
      CREATE TABLE message (guid TEXT, date INTEGER, is_from_me INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE INDEX chat_messages ON chat_message_join(chat_id, message_id);
      INSERT INTO chat VALUES ('target'), ('empty'); BEGIN`);
    const message = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
    const link = db.prepare("INSERT INTO chat_message_join VALUES (1, ?)");
    for (let i = 1; i <= 100_000; i++) {
      message.run(`guid-${i}`, 810000000000000000 + i * 1e9, i === 100_000 ? 1 : 0);
      link.run(i);
    }
    // ROWID, not timestamps, identifies the most recently inserted outgoing row.
    message.run("backdated", 810000000000000000, 1);
    link.run(100_001);
    db.exec("COMMIT");
    const f = fixture();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const messages = yield* makeImsgMessages(f.alertsService);
          expect(yield* messages.lastOutgoingStatus("target")).toBeDefined();
          expect(f.commands.at(-1)?.params["guid"]).toBe("backdated");
          expect(yield* messages.textStatus("target", 0)).toBe("sent");
          expect(yield* messages.textStatus("target", Date.UTC(2030, 0, 1))).toBe("unknown");
          expect(yield* messages.lastOutgoingStatus("empty")).toBeUndefined();
          expect(yield* messages.textStatus("empty", 0)).toBe("unknown");
          expect(yield* messages.recent("absent", 0)).toEqual([]);
          expect(f.commands.some((c) => c.method === "messages.after")).toBe(false);
          db.exec(
            "INSERT INTO chat VALUES ('target'); INSERT INTO message VALUES ('other-chat-incoming', 810000000000000001, 0); INSERT INTO chat_message_join VALUES (3, 100002)",
          );
          expect(yield* messages.lastOutgoingStatus("target")).toBeDefined();
          expect(f.commands.at(-1)?.params["guid"]).toBe("backdated");
          db.exec(
            "INSERT INTO message VALUES ('invalid-date', NULL, 1); INSERT INTO chat_message_join VALUES (1, 100003)",
          );
          expect(yield* messages.textStatus("target", 0)).toBe("unknown");
          yield* Effect.promise(() => rename(path, `${path}.old`));
          const replacement = new DatabaseSync(path);
          replacement.exec(
            "CREATE TABLE chat (chat_identifier TEXT); CREATE TABLE message (guid TEXT, date INTEGER, is_from_me INTEGER); CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)",
          );
          replacement.close();
          expect(yield* messages.lastOutgoingStatus("target")).toBeUndefined();
        }).pipe(
          Effect.provideService(MessageMetadata, messageMetadata(path)),
          Effect.provide(f.dependencies),
        ),
      ),
    );
    expect(await Effect.runPromise(messageMetadata(`${path}.old`).lookup("target"))).toMatchObject({
      guid: "invalid-date",
      createdAt: null,
    });
    const diagnostics: string[] = [];
    await expect(
      Effect.runPromise(
        messageMetadata(join(root, "missing.db"))
          .lookup("private-handle")
          .pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((entry) => {
                  diagnostics.push(JSON.stringify(entry.message));
                }),
              ]),
            ),
          ),
      ),
    ).rejects.toThrow("Messages metadata unavailable");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('"stage":"imsg.metadata.lookup"');
    expect(diagnostics[0]).toContain('"code":"ERR_SQLITE_ERROR"');
    expect(diagnostics[0]).toContain('"outcome":"failed"');
    expect(diagnostics[0]).not.toContain("private-handle");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
