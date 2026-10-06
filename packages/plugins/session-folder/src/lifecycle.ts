import type { Plugin } from "@opencode/plugin/effect";
import { AbsolutePath, Agent, Model, Session } from "@opencode/schema";
import { Cause, Effect, Schema, Semaphore } from "effect";
import { folderFiles, personaPermissions } from "./files.ts";
import { folderSnapshot } from "./protocol.ts";
import { managedFolder } from "./paths.ts";

export const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (error) => new Error(String(error)) });

// ponytail: one lock per root, including native admission; split by session if throughput needs it.
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
    session.location.directory !== files.path(id) || session.agent !== personaID
      ? Effect.fail(new Error("Session folder or persona binding does not match"))
      : Effect.void;
  const ensure = (id: string) =>
    Effect.gen(function* () {
      const session = yield* get(id);
      if (!session) return yield* Effect.fail(new Error("Session does not exist"));
      const source = managedFolder(root, session.location.directory);
      if (!source) return yield* Effect.fail(new Error("Session is outside the managed folders"));
      const target = files.path(id);
      if (source === id) return target;
      const snapshot = yield* io(() => files.read(source));
      if (session.agent !== undefined && session.agent !== snapshot.persona.id)
        return yield* Effect.fail(
          new Error("Native session persona does not match its source folder"),
        );
      if (!(yield* io(() => files.exists(id)))) yield* io(() => files.write(id, snapshot));
      else {
        const prior = yield* io(() => files.read(id));
        if (prior.persona.id !== snapshot.persona.id)
          return yield* Effect.fail(new Error("Native session folder belongs to another persona"));
      }
      yield* ctx.session.update({ sessionID: session.id, permissions: personaPermissions });
      if (!session.agent)
        yield* ctx.session.switchAgent({
          sessionID: session.id,
          agent: Agent.ID.make(snapshot.persona.id),
        });
      yield* ctx.session.move({ sessionID: session.id, directory: AbsolutePath.make(target) });
      yield* ctx.session.wait({ sessionID: session.id });
      return target;
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
        return yield* io(() => files.write(id, snapshot));
      }),
    remove: (id: string) =>
      Effect.gen(function* () {
        if (yield* get(id))
          return yield* Effect.fail(new Error("Remove the session before its folder"));
        return yield* io(() => files.remove(id));
      }),
    create: (id: string, snapshot: typeof folderSnapshot.Type, model: string) =>
      Effect.gen(function* () {
        const session = yield* get(id);
        if (session) {
          yield* bound(session, id, snapshot.persona.id);
          return files.path(id);
        }
        if (yield* io(() => files.exists(id)))
          return yield* Effect.fail(new Error("Session folder already exists"));
        const selected = yield* Effect.try(() => Model.Ref.parse(model));
        const directory = yield* io(() => files.write(id, snapshot));
        yield* ctx.session
          .create({
            id: Session.ID.make(id),
            agent: Agent.ID.make(snapshot.persona.id),
            model: selected,
            location: { directory: AbsolutePath.make(directory) },
            permissions: personaPermissions,
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
