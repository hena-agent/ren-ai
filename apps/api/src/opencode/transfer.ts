import type { OpenCode } from "@opencode/client/effect";
import { AbsolutePath, Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import type { SessionInbox } from "@opencode/schema/session-inbox";
import { Effect, Schema } from "effect";
import { sessionArchive } from "./transfer-format.ts";
import { dirname } from "node:path";
import { sessionFolders, type personaFolderSnapshot } from "@ren-ai/plugin-session-folder/protocol";
import {
  managedFolder,
  personaDirectory,
  sessionDirectory,
} from "@ren-ai/plugin-session-folder/paths";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;
type RestorableSession = Omit<(typeof sessionArchive.Type)["sessions"][number], "pending"> & {
  readonly pending: ReadonlyArray<SessionInbox.User | SessionInbox.Synthetic>;
};
const restorable = (item: SessionInbox.Info): item is SessionInbox.User | SessionInbox.Synthetic =>
  item.type === "user" || item.type === "synthetic";
export interface FolderSnapshotIO {
  readonly inventory: (
    root: string,
  ) => Effect.Effect<ReadonlyArray<typeof personaFolderSnapshot.Type>, Error>;
}

export const exportSessions = (
  client: Client,
  ids: ReadonlyArray<Session.ID>,
  inventory?: {
    readonly root: string;
    readonly snapshots: ReadonlyArray<typeof personaFolderSnapshot.Type>;
  },
) =>
  Effect.gen(function* () {
    const folders = new Map<string, typeof personaFolderSnapshot.Type>();
    for (const snapshot of inventory?.snapshots ?? []) {
      const target = snapshot.sandboxID
        ? sessionDirectory(inventory!.root, snapshot.sandboxID)
        : personaDirectory(inventory!.root, snapshot.snapshot.persona.id);
      if (folders.has(target))
        return yield* Effect.fail(new Error("Duplicate persona scope in inventory"));
      folders.set(target, snapshot);
    }
    const sessions = yield* Effect.forEach(ids, (sessionID) =>
      Effect.gen(function* () {
        const pending = yield* client.session.inbox.list({ sessionID });
        const [last] = (yield* client.message.list({ sessionID, order: "desc", limit: 1 })).data;
        const data = yield* client.session.export({ sessionID, sanitize: false });
        const directory = data.info.location.directory;
        const root = dirname(dirname(directory));
        const source = managedFolder(root, directory);
        if (!source)
          return yield* Effect.fail(
            new Error("Migrate legacy sessions before exporting shared life"),
          );
        if (!folders.has(directory)) {
          if (inventory)
            return yield* Effect.fail(
              new Error("Inventory has no session scope; retry after admission settles"),
            );
          const snapshot = yield* client
            .rpc(sessionFolders)
            .snapshot({ folderID: sessionID }, { location: { directory: root } });
          const target = snapshot.sandboxID
            ? sessionDirectory(root, snapshot.sandboxID)
            : personaDirectory(root, snapshot.snapshot.persona.id);
          if (target !== directory)
            return yield* Effect.fail(
              new Error(
                "Session location does not match its durable persona scope; retry after admission settles",
              ),
            );
          folders.set(directory, snapshot);
        }
        const saved = folders.get(directory);
        const binding = saved?.bindings[sessionID];
        if (!saved || !binding)
          return yield* Effect.fail(
            new Error("Snapshot has no session binding; retry after admission settles"),
          );
        const folder = {
          persona: saved.snapshot.persona,
          agent: saved.snapshot.agent,
          rules: saved.snapshot.rules,
          binding,
        };
        const unfinished =
          last !== undefined &&
          data.messages.at(-1)?.type !== "idle" &&
          (last.type === "user" ||
            last.type === "synthetic" ||
            !data.messages.some((message) => message.id === last.id));
        return {
          ...data,
          pending,
          folder,
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
    return Schema.encodeSync(sessionArchive)({
      version: 2,
      sessions,
      personas: [...folders.values()],
    });
  }).pipe(
    Effect.mapError(
      (error) => new Error(error instanceof Error ? error.message : JSON.stringify(error)),
    ),
  );

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

/** Decode and order the complete archive before any OpenCode mutations. */
const decodeArchive = (contents: string) =>
  Schema.decodeUnknownEffect(sessionArchive)(contents).pipe(
    Effect.mapError(() => new Error("Invalid private session archive")),
  );

const orderedSessions = (data: typeof sessionArchive.Type) =>
  Effect.gen(function* () {
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
      if (entry.folder.persona.id !== entry.info.agent)
        return yield* Effect.fail(new Error("Snapshot persona does not match session agent"));
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
    return ordered;
  });

const archiveBindings = (archive: typeof sessionArchive.Type) => {
  const targets = new Map<string, string>();
  const roots = new Set<string>();
  for (const folder of archive.personas) {
    const root = folder.sandboxID
      ? `sandbox:${folder.sandboxID}`
      : `persona:${folder.snapshot.persona.id}`;
    if (roots.has(root)) throw new Error("Duplicate persona scope in archive");
    roots.add(root);
    for (const [id, binding] of Object.entries(folder.bindings)) {
      const session = archive.sessions.find((entry) => entry.info.id === id);
      if (
        targets.has(id) ||
        binding.personaID !== folder.snapshot.persona.id ||
        !folder.relationships[binding.conversationKey]
      )
        throw new Error("Invalid or duplicate archived binding");
      if (
        session &&
        (session.info.agent !== binding.personaID ||
          session.folder?.binding?.conversationKey !== binding.conversationKey)
      )
        throw new Error("Archived session does not match persona binding");
      targets.set(id, "");
    }
  }
  for (const session of archive.sessions)
    if (!targets.has(session.info.id))
      throw new Error("Archive is missing a persona scope for its session");
  return targets;
};

/** Validate the entire archive and all destination IDs before importing anything. */
export const restoreSessions = (client: Client, contents: string, directory: string) =>
  Effect.gen(function* () {
    const archive = yield* decodeArchive(contents);
    const ordered = yield* orderedSessions(archive);
    const targets = yield* Effect.try(() => archiveBindings(archive));
    for (const entry of ordered) {
      const present = yield* client.session.get({ sessionID: entry.info.id }).pipe(
        Effect.as(true),
        Effect.catchTag("SessionNotFoundError", () => Effect.succeed(false)),
      );
      if (present) return yield* Effect.fail(new Error(`Session ${entry.info.id} already exists`));
    }
    for (const folder of archive.personas) {
      const target = yield* client
        .rpc(sessionFolders)
        .restore({ snapshot: folder }, { location: { directory } });
      for (const id of Object.keys(folder.bindings)) targets.set(id, target);
    }
    for (const entry of ordered) {
      const sessionID = entry.info.id;
      const target = targets.get(sessionID)!;
      // Recreated folders may still have an empty agent registry cached after deletion.
      yield* client.debug.location.evict({ location: { directory: target } });
      yield* client.session.import({
        info: entry.info,
        messages: restoredHistory(entry),
        location: { directory: AbsolutePath.make(target) },
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
  }).pipe(
    Effect.mapError(
      (error) => new Error(error instanceof Error ? error.message : JSON.stringify(error)),
    ),
  );
