import { createHash } from "node:crypto";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Conversation } from "../conversations/conversations.ts";
import type { IncomingMessage, Messages } from "../messages/messages.ts";
import { edited, unsent } from "../transcript/transcript.ts";

const editWindow = 15 * 60_000;
const unsendWindow = 2 * 60_000;

interface WatchedMessage {
  readonly row: IncomingMessage;
  text: string;
  revision: number;
}

interface WatchedConversation {
  readonly conversation: Conversation;
  readonly rows: Map<string, WatchedMessage>;
}

/** Only admitted messages are seeded on restart; changes made while down become the baseline. */
export const watchEdits = (
  messages: Messages,
  prompt: (sessionID: string, id: string, text: string) => Effect.Effect<void, Error>,
  timeZone: (personaID: string) => string,
  signal: (conversation: Conversation) => void,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const watched = new Map<number, WatchedConversation>();
    const remember = (conversation: Conversation, row: IncomingMessage) => {
      if (!row.text) return;
      let group = watched.get(conversation.id);
      if (!group) {
        group = { conversation, rows: new Map() };
        watched.set(conversation.id, group);
      }
      group.rows.set(row.guid, { row, text: row.text, revision: 0 });
    };
    const now = yield* Clock.currentTimeMillis;
    const active = yield* sql<Conversation>`SELECT conversation.id, user.handle,
      conversation.persona_id AS personaID, conversation.session_id AS sessionID
      FROM intake_last JOIN conversation ON conversation.id = intake_last.conversation_id
      JOIN user ON user.id = conversation.user_id WHERE intake_last.date >= ${now - editWindow}`;
    for (const conversation of active) {
      const seen = yield* sql<{
        guid: string;
      }>`SELECT guid FROM intake_seen WHERE session_id = ${conversation.sessionID}`;
      const known = new Set(seen.map((item) => item.guid));
      const recent = yield* messages.recent(conversation.handle, now - editWindow);
      for (const row of recent) {
        if (known.has(row.guid)) remember(conversation, row);
      }
    }
    const inspect = (
      group: WatchedConversation,
      guid: string,
      entry: WatchedMessage,
      currentText: string,
      time: number,
    ) =>
      Effect.gen(function* () {
        if (currentText === entry.text) return;
        if (!currentText && entry.row.createdAt + unsendWindow < time) return;
        const zone = timeZone(group.conversation.personaID);
        const text = currentText ? edited(entry.text, currentText, time, zone) : unsent(time, zone);
        const revision = entry.revision + 1;
        const promptID = `edit_${createHash("sha256")
          .update(
            [group.conversation.sessionID, guid, entry.text, currentText, String(revision)].join(
              "\0",
            ),
          )
          .digest("hex")}`;
        yield* prompt(group.conversation.sessionID, promptID, text);
        entry.text = currentText;
        entry.revision = revision;
        if (!currentText) group.rows.delete(guid);
        signal(group.conversation);
      });
    const poll = Effect.gen(function* () {
      const time = yield* Clock.currentTimeMillis;
      for (const [id, group] of watched) {
        for (const [guid, entry] of group.rows) {
          if (entry.row.createdAt + editWindow < time) group.rows.delete(guid);
        }
        if (!group.rows.size) {
          // Stryker disable next-line CallExpression -- empty-group cleanup changes only private memory, not polling behavior
          watched.delete(id);
          continue;
        }
        const since = Math.min(...[...group.rows.values()].map((entry) => entry.row.createdAt));
        const recent = yield* messages.recent(group.conversation.handle, since);
        const byGuid = new Map(recent.map((row) => [row.guid, row]));
        for (const [guid, entry] of group.rows) {
          const current = byGuid.get(guid);
          if (current) yield* inspect(group, guid, entry, current.text, time);
        }
      }
    });
    const monitor = Effect.forever(
      Effect.sleep("1 second").pipe(Effect.flatMap(() => poll.pipe(Effect.catch(Effect.logError)))),
    );
    return { remember, monitor };
  });
