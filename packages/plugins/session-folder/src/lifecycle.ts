import type { Plugin } from "@opencode/plugin/effect";
import { AbsolutePath, Agent, Model, Session } from "@opencode/schema";
import { Cause, Effect, Schema, Semaphore } from "effect";
import { folderFiles, personaPermissions, socialPermissions } from "./files.ts";
import { folderSnapshot } from "./protocol.ts";
import { managedFolder } from "./paths.ts";
import { readSessionBinding } from "./bindings.ts";
import { isDeepStrictEqual } from "node:util";

export const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (error) => new Error(String(error)) }).pipe(
    Effect.uninterruptible,
  );

// ponytail: serialize folder admission at the installation root; model turns use per-persona locks.
const roots = new Map<string, { lock: Semaphore.Semaphore; references: number }>();
export const rootLock = (root: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const state = roots.get(root) ?? { lock: Semaphore.makeUnsafe(1), references: 0 };
      state.references++;
      roots.set(root, state);
      return state;
    }),
    (state) =>
      Effect.sync(() => {
        state.references--;
        if (state.references === 0) roots.delete(root);
      }),
  ).pipe(Effect.map((state) => state.lock));

export const folderLifecycle = (ctx: Plugin.Context, root: string) => {
  const files = folderFiles(root);
  const get = (id: string) =>
    ctx.session
      .get({ sessionID: Session.ID.make(id) })
      .pipe(
        Effect.catchCause((cause) =>
          Schema.is(Schema.Struct({ _tag: Schema.Literal("Session.NotFoundError") }))(
            Cause.squash(cause),
          )
            ? Effect.succeed(undefined)
            : Effect.failCause(cause),
        ),
      );
  const bound = (session: Session.Info, id: string, personaID: string) =>
    Effect.gen(function* () {
      const binding = yield* io(() => files.locate(id));
      yield* io(() => readSessionBinding(binding.directory, id));
      if (
        session.location.directory !== binding.directory ||
        session.agent !== personaID ||
        binding.personaID !== personaID
      )
        return yield* Effect.fail(new Error("Session folder or persona binding does not match"));
      return binding.directory;
    });
  const relocate = (session: Session.Info, target: string, personaID: string) =>
    Effect.gen(function* () {
      yield* ctx.session.update({ sessionID: session.id, permissions: personaPermissions });
      if (!session.agent)
        yield* ctx.session.switchAgent({ sessionID: session.id, agent: Agent.ID.make(personaID) });
      yield* ctx.session.move({ sessionID: session.id, directory: AbsolutePath.make(target) });
      yield* ctx.session.wait({ sessionID: session.id });
      return target;
    });
  const resume = (session: Session.Info, id: string) =>
    Effect.gen(function* () {
      const binding = yield* io(() => files.locate(id));
      if (!binding.sandbox || session.location.directory === binding.directory) {
        const target = yield* bound(session, id, session.agent ?? "");
        const permissions = binding.social ? socialPermissions : personaPermissions;
        // Root reconciliation owns persisted policy; prompt admission preserves session overrides.
        if (ctx.location.directory === root && !isDeepStrictEqual(session.permissions, permissions))
          yield* ctx.session.update({ sessionID: session.id, permissions });
        return target;
      }
      const sourceSnapshot = yield* io(() => files.readAt(session.location.directory));
      yield* io(() => readSessionBinding(binding.directory, id));
      if (
        sourceSnapshot.persona.id !== binding.personaID ||
        (session.agent && session.agent !== binding.personaID)
      )
        return yield* Effect.fail(new Error("Pending Sandbox persona binding does not match"));
      return yield* relocate(session, binding.directory, binding.personaID);
    });
  const ensure = (id: string) =>
    Effect.gen(function* () {
      const session = yield* get(id);
      if (!session) return yield* Effect.fail(new Error("Session does not exist"));
      const source = managedFolder(root, session.location.directory);
      if (!source) return yield* Effect.fail(new Error("Session is outside the managed folders"));
      if (yield* io(() => files.exists(id))) return yield* resume(session, id);
      const parentID = session.fork?.sessionID ?? session.parentID;
      const snapshot = parentID
        ? yield* io(() => files.read(parentID))
        : yield* io(() => files.readAt(session.location.directory));
      if (session.agent !== undefined && session.agent !== snapshot.persona.id)
        return yield* Effect.fail(
          new Error("Native session persona does not match its source folder"),
        );
      const target = yield* io(() =>
        files.write(id, snapshot, { sandbox: true, conversationKey: id, writable: true }),
      );
      return yield* relocate(session, target, snapshot.persona.id);
    });
  return {
    files,
    ensure,
    adopt: (id: string) =>
      Effect.gen(function* () {
        const session = yield* get(id);
        if (session && managedFolder(root, session.location.directory)) yield* ensure(id);
      }),
    update: (id: string, snapshot: typeof folderSnapshot.Type) =>
      Effect.gen(function* () {
        const session = yield* get(id);
        if (!session) return yield* Effect.fail(new Error("Session does not exist"));
        yield* bound(session, id, snapshot.persona.id);
        return yield* io(() => files.update(id, snapshot));
      }),
    remove: (id: string) =>
      Effect.gen(function* () {
        if (yield* get(id))
          return yield* Effect.fail(new Error("Remove the session before its folder"));
        return yield* io(() => files.remove(id));
      }),
    create: (
      id: string,
      snapshot: typeof folderSnapshot.Type,
      model: string,
      conversationKey?: string,
      writable?: boolean,
    ) =>
      Effect.gen(function* () {
        const session = yield* get(id);
        if (session) {
          const target = yield* bound(session, id, snapshot.persona.id);
          const binding = yield* io(() => files.locate(id));
          if (snapshot.binding && !isDeepStrictEqual(snapshot.binding.social, binding.social))
            return yield* Effect.fail(new Error("Session social scope does not match"));
          if (conversationKey !== undefined && binding.conversationKey !== conversationKey)
            return yield* Effect.fail(new Error("Session Conversation binding does not match"));
          return target;
        }
        const selected = yield* Effect.try(() => Model.Ref.parse(model));
        const directory = yield* io(() =>
          files.write(id, snapshot, {
            ...(conversationKey !== undefined && { conversationKey }),
            ...(writable !== undefined && { writable }),
          }),
        );
        yield* ctx.session
          .create({
            id: Session.ID.make(id),
            agent: Agent.ID.make(snapshot.persona.id),
            model: selected,
            location: { directory: AbsolutePath.make(directory) },
            permissions: snapshot.binding?.social ? socialPermissions : personaPermissions,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                // A failed response is not proof that creation failed: never remove an existing session's folder.
                if (!(yield* get(id))) yield* io(() => files.remove(id));
                return yield* Effect.failCause(cause);
              }),
            ),
          );
        return directory;
      }).pipe(Effect.uninterruptible),
  };
};
