import type { OpenCode } from "@opencode/client/effect";
import { AbsolutePath, Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import type { SessionInbox } from "@opencode/schema/session-inbox";
import { Effect, Schema } from "effect";
import { sessionArchive } from "./transfer-format.ts";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;
type RestorableSession = Omit<(typeof sessionArchive.Type)["sessions"][number], "pending"> & {
  readonly pending: ReadonlyArray<SessionInbox.User | SessionInbox.Synthetic>;
};
const restorable = (item: SessionInbox.Info): item is SessionInbox.User | SessionInbox.Synthetic =>
  item.type === "user" || item.type === "synthetic";
export const exportSessions = (client: Client, ids: ReadonlyArray<Session.ID>) =>
  Effect.gen(function* () {
    const sessions = yield* Effect.forEach(ids, (sessionID) =>
      Effect.gen(function* () {
        const pending = yield* client.session.inbox.list({ sessionID });
        const [last] = (yield* client.message.list({ sessionID, order: "desc", limit: 1 })).data;
        const data = yield* client.session.export({ sessionID, sanitize: false });
        const unfinished =
          last !== undefined &&
          data.messages.at(-1)?.type !== "idle" &&
          (last.type === "user" ||
            last.type === "synthetic" ||
            !data.messages.some((message) => message.id === last.id));
        return {
          ...data,
          pending,
          ...(unfinished
            ? {
                recovery: {
                  id: SessionMessage.ID.make(`msg_cutover_${last.id}`),
                  tools:
                    last.type === "assistant"
                      ? last.content
                          .filter((part) => part.type === "tool")
                          .map((part) => ({ callID: part.id, tool: part.name, state: part.state }))
                      : [],
                },
              }
            : {}),
        };
      }),
    );
    return Schema.encodeSync(sessionArchive)({ version: 1, sessions });
  }).pipe(Effect.mapError((error) => new Error(String(error))));

const restoreInput = (
  client: Client,
  sessionID: Session.ID,
  item: SessionInbox.User | SessionInbox.Synthetic,
) => {
  const common = { sessionID, id: item.id, delivery: item.delivery, resume: false };
  if (item.type === "user")
    return client.session.prompt({
      ...item.payload,
      ...common,
      files: item.payload.files?.map((file) => ({
        uri: `data:${file.mime};base64,${file.data}`,
        name: file.name,
        description: file.description,
        mention: file.mention,
      })),
    });
  return client.session.synthetic({ ...item.payload, ...common });
};

const restoredHistory = (entry: (typeof sessionArchive.Type)["sessions"][number]) => {
  if (!entry.recovery) return entry.messages;
  return [
    ...entry.messages,
    SessionMessage.Synthetic.make({
      id: entry.recovery.id,
      time: { created: entry.info.time.updated },
      text: `These recorded tool attempts came from an interrupted assistant. Completed effects already happened: do not repeat them. Running or errored attempts may have taken effect; use delivery reconciliation.\n${JSON.stringify(entry.recovery.tools)}`,
    }),
  ];
};

/** Validate the entire archive and all destination IDs before importing anything. */
export const restoreSessions = (client: Client, contents: string, directory: string) =>
  Effect.gen(function* () {
    const data = yield* Schema.decodeUnknownEffect(sessionArchive)(contents);
    const ids = new Set(data.sessions.map((entry) => entry.info.id));
    if (ids.size !== data.sessions.length)
      return yield* Effect.fail(new Error("Duplicate session in archive"));
    const validated: Array<RestorableSession> = [];
    for (const entry of data.sessions) {
      if (entry.info.fork || entry.info.revert)
        return yield* Effect.fail(
          new Error("Use a full OpenCode volume restore for fork/revert state"),
        );
      const pending = entry.pending;
      if (!pending.every(restorable))
        return yield* Effect.fail(new Error("Drain pending control operations before migration"));
      const present = yield* client.session.get({ sessionID: entry.info.id }).pipe(
        Effect.as(true),
        Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
      );
      if (present) return yield* Effect.fail(new Error(`Session ${entry.info.id} already exists`));
      validated.push({ ...entry, pending });
    }
    const remaining = [...validated];
    const ordered: Array<RestorableSession> = [];
    while (remaining.length) {
      const index = remaining.findIndex(
        (entry) => !remaining.some((parent) => parent.info.id === entry.info.parentID),
      );
      if (index < 0) return yield* Effect.fail(new Error("Cyclic session parents in archive"));
      const [entry] = remaining.splice(index, 1);
      ordered.push(entry!);
    }
    for (const entry of ordered) {
      const sessionID = entry.info.id;
      yield* client.session.import({
        info: entry.info,
        messages: restoredHistory(entry),
        location: { directory: AbsolutePath.make(directory) },
      });
      for (const item of entry.pending) {
        yield* restoreInput(client, sessionID, item);
      }
      if (entry.recovery && entry.pending.length === 0)
        yield* client.session.synthetic({
          sessionID,
          id: SessionMessage.ID.make(`${entry.recovery.id}_resume`),
          delivery: "queue",
          resume: false,
          text: "Continue the interrupted Conversation using its preserved history and recorded tool effects.",
        });
    }
    return yield* Effect.void;
  }).pipe(Effect.mapError((error) => new Error(String(error))));
