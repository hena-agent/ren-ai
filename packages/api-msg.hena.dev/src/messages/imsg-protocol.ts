import type { IncomingMessage } from "./messages.ts";

interface RpcReply {
  readonly id: number;
  readonly result?: JsonRecord;
  readonly error?: { readonly code: number; readonly message: string };
}

interface RpcNotice {
  readonly method: string;
  readonly params: JsonRecord;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonRecord
  | ReadonlyArray<JsonValue>;
interface JsonRecord {
  readonly [key: string]: JsonValue;
}

const isSendState = (value: JsonValue): value is "pending" | "sent" | "delivered" | "failed" =>
  value === "pending" || value === "sent" || value === "delivered" || value === "failed";
const safeInteger = (value: JsonValue): value is number => Number.isSafeInteger(value);

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow untrusted imsg JSON objects
const record = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const attachment = (value: JsonValue) => {
  if (!record(value)) throw new Error("Invalid imsg attachment");
  const path = value["original_path"];
  const mime = value["mime_type"];
  const uti = value["uti"];
  const missing = value["missing"];
  if (
    (path !== undefined && typeof path !== "string") ||
    (mime !== undefined && mime !== null && typeof mime !== "string") ||
    (uti !== undefined && uti !== null && typeof uti !== "string") ||
    (missing !== undefined && typeof missing !== "boolean")
  )
    throw new Error("Invalid imsg attachment");
  return {
    path: path ?? "",
    mimeType: mime ?? null,
    uti: uti ?? null,
    missing: missing === true || !path,
  };
};

const emoji: Readonly<Record<string, string>> = {
  love: "❤️",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasis: "‼️",
  question: "❓",
};

const reaction = (value: JsonRecord) => {
  if (value["is_reaction"] !== true) return undefined;
  const type = value["reaction_type"];
  const icon = value["reaction_emoji"];
  const target = value["reacted_to_guid"];
  const added = value["is_reaction_add"];
  if (
    typeof type !== "string" ||
    (icon !== undefined && typeof icon !== "string") ||
    typeof target !== "string" ||
    typeof added !== "boolean"
  )
    throw new Error("Invalid imsg reaction");
  return { emoji: icon ?? emoji[type] ?? type, targetGuid: target, added };
};

const payload = (value: JsonRecord) => {
  const balloon = value["balloon_bundle_id"];
  if (balloon !== undefined && balloon !== null && typeof balloon !== "string")
    throw new Error("Invalid imsg balloon");
  if (balloon === "com.apple.messages.URLBalloonProvider") return undefined;
  if (balloon && /location|findmy/i.test(balloon)) return "location";
  if (balloon || value["poll"] !== undefined) return "app";
  return undefined;
};

/** The only entry point for bytes received from imsg. */
export const parseRpc = (line: string): RpcReply | RpcNotice => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parse untrusted imsg RPC line
  const value: unknown = JSON.parse(line);
  if (!record(value) || value["jsonrpc"] !== "2.0") throw new Error("Invalid imsg RPC frame");
  if (typeof value["id"] === "number") {
    const error = value["error"];
    if (record(error) && typeof error["code"] === "number" && typeof error["message"] === "string")
      return { id: value["id"], error: { code: error["code"], message: error["message"] } };
    if (record(value["result"])) return { id: value["id"], result: value["result"] };
  }
  if (typeof value["method"] === "string" && record(value["params"]))
    return { method: value["method"], params: value["params"] };
  throw new Error("Invalid imsg RPC frame");
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode untrusted imsg message
export const messageRow = (value: unknown): IncomingMessage & { chatID: number } => {
  if (
    !record(value) ||
    !safeInteger(value["id"]) ||
    typeof value["guid"] !== "string" ||
    typeof value["chat_identifier"] !== "string" ||
    typeof value["chat_id"] !== "number" ||
    typeof value["created_at"] !== "string" ||
    typeof value["is_from_me"] !== "boolean" ||
    (typeof value["text"] !== "string" && value["text"] !== null)
  )
    throw new Error("Invalid imsg message");
  const createdAt = Date.parse(value["created_at"]);
  if (!Number.isFinite(createdAt)) throw new Error("Invalid imsg message date");
  const attachments = value["attachments"];
  if (attachments !== undefined && !Array.isArray(attachments))
    throw new Error("Invalid imsg attachments");
  const reply = value["thread_originator_guid"];
  if (reply !== undefined && reply !== null && typeof reply !== "string")
    throw new Error("Invalid imsg reply target");
  const tapback = reaction(value);
  const kind = payload(value);
  return {
    id: value["id"],
    guid: value["guid"],
    handle: value["chat_identifier"],
    chatID: value["chat_id"],
    createdAt,
    text: value["text"] ?? "",
    fromMe: value["is_from_me"],
    ...(attachments === undefined ? {} : { attachments: attachments.map(attachment) }),
    ...(tapback ? { tapback } : {}),
    ...(reply ? { replyToGuid: reply } : {}),
    ...(kind ? { payload: kind } : {}),
  };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode untrusted imsg scan page
export const afterPage = (value: unknown) => {
  if (
    !record(value) ||
    !Array.isArray(value["messages"]) ||
    !safeInteger(value["next_rowid"]) ||
    typeof value["has_more"] !== "boolean"
  )
    throw new Error("Invalid imsg messages.after result");
  return {
    rows: value["messages"].map(messageRow),
    next: value["next_rowid"],
    more: value["has_more"],
  };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode untrusted imsg history page
export const historyPage = (value: unknown) => {
  if (!record(value) || !Array.isArray(value["messages"]))
    throw new Error("Invalid imsg messages.history result");
  return value["messages"].map(messageRow);
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode untrusted imsg subscription
export const subscription = (value: unknown) => {
  if (!record(value) || !safeInteger(value["subscription"]))
    throw new Error("Invalid imsg subscription");
  return value["subscription"];
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode untrusted imsg send acknowledgement
export const accepted = (value: unknown) => {
  if (
    !record(value) ||
    value["ok"] !== true ||
    (value["guid"] !== undefined && typeof value["guid"] !== "string")
  )
    throw new Error("Invalid imsg send result");
  return { guid: typeof value["guid"] === "string" ? value["guid"] : null };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode untrusted imsg status
export const sendStatus = (value: unknown) => {
  if (!record(value)) throw new Error("Invalid imsg send status");
  const state = value["send_state"];
  if (!isSendState(state)) throw new Error("Invalid imsg send status");
  const fields = value["status_fields"];
  if (fields !== null && !record(fields)) throw new Error("Invalid imsg status fields");
  return {
    state,
    error: record(fields) && typeof fields["error"] === "number" ? fields["error"] : 0,
    dateRead:
      record(fields) && typeof fields["date_read"] === "string" ? fields["date_read"] : null,
  };
};
