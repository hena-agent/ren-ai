import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, openSync } from "node:fs";
import { Schema } from "effect";
import type { BridgeMessage } from "./bridge-protocol.ts";
import { messageDetail } from "../gateway/protocol.ts";
import type { IncomingMessage } from "./messages.ts";

/** Messages' code for a recipient without iMessage, kept so statuses mean what they did. */
export const noIMessage = 22;

const Row = Schema.Struct({
  id: Schema.Number,
  guid: Schema.String,
  handle: Schema.String,
  created_at: Schema.Number,
  text: Schema.String,
  from_me: Schema.Number,
  state: Schema.NullOr(Schema.Literals(["pending", "sent", "delivered", "failed"])),
  error: Schema.Number,
  read_at: Schema.NullOr(Schema.Number),
  detail: Schema.fromJsonString(messageDetail),
});
const decodeRow = Schema.decodeUnknownSync(Row);

type Detail = typeof messageDetail.Type;

/** Handles in rows match the application's: an email or an international phone number. */
const handleOf = (uri: string) =>
  uri.startsWith("mailto:") ? uri.slice(7).toLowerCase() : uri.replace(/^tel:/, "");

export const uriOf = (handle: string) =>
  handle.includes("@") ? `mailto:${handle.toLowerCase()}` : `tel:${handle}`;

const normal = (uri: string | null) => (uri && /^mailto:/i.test(uri) ? uri.toLowerCase() : uri);

const message = (row: typeof Row.Type): IncomingMessage => ({
  id: row.id,
  guid: row.guid,
  handle: row.handle,
  createdAt: row.created_at,
  text: row.text,
  fromMe: row.from_me === 1,
  ...row.detail,
});

type Stored = Extract<BridgeMessage, { kind: "text" | "tapback" }>;

const detail = (event: Stored): Detail => {
  if (event.kind === "tapback")
    return { tapback: { emoji: event.emoji, targetGuid: event.target, added: event.added } };
  return {
    ...(event.attachments.length
      ? {
          attachments: event.attachments.map((attachment) => ({
            path: attachment.path ?? "",
            mimeType: attachment.mime,
            uti: attachment.uti,
            missing: attachment.path === null,
          })),
        }
      : {}),
    ...(event.replyTo ? { replyToGuid: event.replyTo } : {}),
    ...(event.payload ? { payload: event.payload } : {}),
  };
};

/** The gateway's durable record of one service handle's conversations. */
export const openHistory = (path: string, serviceHandle: string) => {
  const service = uriOf(serviceHandle);
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS message (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      text TEXT NOT NULL,
      from_me INTEGER NOT NULL,
      state TEXT CHECK (state IN ('pending', 'sent', 'delivered', 'failed')),
      error INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER,
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS message_handle ON message (handle, id);
    CREATE TABLE IF NOT EXISTS send_fence (guid TEXT PRIMARY KEY);`);
  const insert =
    db.prepare(`INSERT INTO message (guid, handle, created_at, text, from_me, state, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (guid) DO NOTHING RETURNING *`);
  const all = (sql: string, ...values: Array<string | number>) =>
    db
      .prepare(sql)
      .all(...values)
      .map((record) => message(decodeRow(record)));
  const one = (sql: string, ...values: Array<string | number>) => {
    const record = db.prepare(sql).get(...values);
    return record && decodeRow(record);
  };
  const run = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).run(...values);
  const add = (event: Stored, handle: string, fromMe: boolean, text: string) => {
    const record = insert.get(
      event.guid,
      handle,
      event.sentAt,
      text,
      fromMe ? 1 : 0,
      fromMe ? "sent" : null,
      JSON.stringify(detail(event)),
    );
    return record && message(decodeRow(record));
  };
  const receipt = (event: BridgeMessage, handle: string) => {
    const target = one(
      `SELECT * FROM message WHERE guid = ? AND handle = ? AND from_me = 1`,
      event.guid,
      handle,
    );
    if (!target) return;
    run(`UPDATE message SET state = 'delivered', error = 0 WHERE id = ?`, target.id);
    // Reading one message reads every earlier one in the conversation.
    if (event.kind === "read")
      run(
        `UPDATE message SET read_at = ? WHERE handle = ? AND from_me = 1 AND id <= ? AND read_at IS NULL`,
        event.sentAt,
        handle,
        target.id,
      );
  };
  const conversation = (event: BridgeMessage) => {
    const participants = (event.participants ?? []).map(normal);
    const sender = normal(event.sender);
    const other = participants.find((participant) => participant !== service);
    if (participants.length !== 2 || !participants.includes(service) || !other) return undefined;
    if (sender !== service && sender !== other) return undefined;
    return { handle: handleOf(other), fromMe: sender === service };
  };
  return {
    /** Applies one bridge event; returns the row it created, if any. */
    apply: (event: BridgeMessage): IncomingMessage | undefined => {
      if (event.kind === "delivered" || event.kind === "read") {
        const sender = normal(event.sender);
        if (sender && sender !== service) receipt(event, handleOf(sender));
        return undefined;
      }
      const party = conversation(event);
      if (!party) return undefined;
      if (event.kind === "text") return add(event, party.handle, party.fromMe, event.text);
      if (event.kind === "tapback") return add(event, party.handle, party.fromMe, "");
      // Only a message's author can edit or unsend it.
      run(
        `UPDATE message SET text = ? WHERE guid = ? AND handle = ? AND from_me = ?`,
        event.kind === "edit" ? event.text : "",
        event.target,
        party.handle,
        party.fromMe ? 1 : 0,
      );
      return undefined;
    },
    /** Records an outgoing text before it is submitted, so a crash leaves it in doubt, not lost. */
    outgoing: (guid: string, handle: string, text: string, createdAt: number) => {
      const admitted = db
        .prepare(`INSERT INTO message
        (guid, handle, created_at, text, from_me, state)
        SELECT ?, ?, ?, ?, 1, 'pending' WHERE NOT EXISTS
        (SELECT 1 FROM send_fence WHERE guid = ?)
        ON CONFLICT (guid) DO NOTHING RETURNING *`)
        .get(guid, handle, createdAt, text, guid);
      if (admitted) return message(decodeRow(admitted));
      const existing = one(`SELECT * FROM message WHERE guid = ?`, guid);
      if (
        existing &&
        (existing.handle !== handle || existing.text !== text || existing.from_me !== 1)
      )
        throw new Error("Send identity conflict");
      return undefined;
    },
    /** Fence missing attempts atomically with admission, including across restarts. */
    fence: (guid: string) => {
      run(
        `INSERT OR IGNORE INTO send_fence SELECT ? WHERE NOT EXISTS
        (SELECT 1 FROM message WHERE guid = ?)`,
        guid,
        guid,
      );
    },
    settle: (guid: string, state: "sent" | "failed", error = 0) => {
      run(
        `UPDATE message SET state = ?, error = ? WHERE guid = ? AND state = 'pending'`,
        state,
        error,
        guid,
      );
    },
    after: (rowID: number, limit = -1) =>
      all(`SELECT * FROM message WHERE id > ? ORDER BY id LIMIT ?`, rowID, limit),
    recent: (handle: string, since: number) =>
      all(`SELECT * FROM message WHERE handle = ? AND created_at >= ? ORDER BY id`, handle, since),
    status: (guid: string) => {
      const row = one(`SELECT * FROM message WHERE guid = ? AND from_me = 1`, guid);
      return {
        state:
          row?.state ??
          (db.prepare(`SELECT 1 FROM send_fence WHERE guid = ?`).get(guid)
            ? ("failed" as const)
            : ("pending" as const)),
        error: row?.error ?? 0,
        dateRead: row?.read_at ?? null,
      };
    },
    /** The status of the latest outgoing row to a handle created at or after since. */
    lastOutgoing: (handle: string, since = 0) => {
      const row = one(
        `SELECT * FROM message WHERE handle = ? AND from_me = 1 AND created_at >= ?
        ORDER BY id DESC LIMIT 1`,
        handle,
        since,
      );
      return row && { state: row.state, error: row.error, readAt: row.read_at };
    },
    /** The latest message from the other person after a row, ignoring tapbacks. */
    lastIncoming: (handle: string, after = 0) => {
      const row = one(
        `SELECT * FROM message WHERE handle = ? AND from_me = 0 AND id > ?
        AND json_extract(detail, '$.tapback') IS NULL ORDER BY id DESC LIMIT 1`,
        handle,
        after,
      );
      return row && message(row);
    },
    lastID: () => one(`SELECT * FROM message ORDER BY id DESC LIMIT 1`)?.id ?? 0,
    close: () => db.close(),
  };
};
