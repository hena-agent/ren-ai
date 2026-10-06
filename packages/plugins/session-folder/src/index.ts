import { Plugin } from "@opencode/plugin/effect";
import { Deferred, Effect, Schema, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { folderID as identifier, sessionFolders } from "./protocol.ts";
import { folderLifecycle, io, rootLock } from "./lifecycle.ts";
import { managedFolder } from "./paths.ts";

export const sessionFolderPlugin = (root: string) =>
  Plugin.define({
    id: "ren-ai.session-folder",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (ctx.location.directory !== root && !managedFolder(root, ctx.location.directory)) return;
        const lock = yield* rootLock(root);
        const lifecycle = folderLifecycle(ctx, root);
        const locked = lock.withPermits(1);
        if (ctx.location.directory !== root) {
          yield* ctx.session.hook("prompt", (event) =>
            locked(lifecycle.ensure(event.sessionID)).pipe(Effect.asVoid, Effect.orDie),
          );
          return;
        }
        const { files } = lifecycle;
        let synchronize: Effect.Effect<void> = Effect.void;
        const prepare = <A, E>(work: Effect.Effect<A, E>) =>
          synchronize.pipe(Effect.andThen(locked(work)));
        const registration = yield* ctx.rpc.register(sessionFolders, {
          create: ({ folderID, snapshot, model }, call) =>
            prepare(lifecycle.create(folderID, snapshot, model)).pipe(
              Effect.mapError((error) =>
                call.error("failed", "Cannot create persona session", String(error)),
              ),
            ),
          update: ({ folderID, snapshot }, call) =>
            locked(lifecycle.update(folderID, snapshot)).pipe(
              Effect.mapError((error) =>
                call.error("failed", "Cannot update session folder", String(error)),
              ),
            ),
          ensure: ({ folderID }, call) =>
            locked(lifecycle.ensure(folderID)).pipe(
              Effect.mapError((error) =>
                call.error("failed", "Cannot ensure session folder", String(error)),
              ),
            ),
          write: ({ folderID, snapshot }, call) =>
            prepare(io(() => files.write(folderID, snapshot))).pipe(
              Effect.mapError((error) =>
                call.error("failed", "Cannot write session folder", String(error)),
              ),
            ),
          read: ({ folderID }, call) =>
            locked(io(() => files.read(folderID))).pipe(
              Effect.mapError((error) =>
                call.error("failed", "Cannot read session folder", String(error)),
              ),
            ),
          remove: ({ folderID }, call) =>
            locked(lifecycle.remove(folderID)).pipe(
              Effect.andThen(() => synchronize),
              Effect.as(null),
              Effect.mapError((error) =>
                call.error("failed", "Cannot remove session folder", String(error)),
              ),
            ),
        });
        const pending = new Map<string, Deferred.Deferred<void>>();
        const marker = Schema.Struct({
          type: Schema.Literal("rpc.ren-ai.session-folders.barrier"),
          location: Schema.Struct({ directory: Schema.Literal(root) }),
          data: Schema.Struct({ id: Schema.String }),
        });
        // A removed ID may be prepared again before its deletion callback runs.
        // Drain that same ordered public stream before acquiring the file lock.
        synchronize = Effect.gen(function* () {
          const id = randomUUID();
          const finished = Deferred.makeUnsafe<void>();
          pending.set(id, finished);
          yield* registration.events.emit("barrier", { id }).pipe(Effect.orDie);
          yield* Deferred.await(finished);
        });
        yield* ctx.event.subscribe().pipe(
          Stream.filter(
            (event) =>
              event.type === "session.deleted" ||
              event.type === "session.created" ||
              event.type === "session.forked" ||
              Schema.is(marker)(event),
          ),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (Schema.is(marker)(event)) {
                const finished = pending.get(event.data.id)!;
                pending.delete(event.data.id);
                yield* Deferred.succeed(finished, undefined);
                return;
              }
              const { sessionID } = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ sessionID: identifier }),
              )(event.data);
              yield* locked(
                event.type === "session.deleted"
                  ? io(() => files.remove(sessionID))
                  : lifecycle.adopt(sessionID),
              );
            }).pipe(Effect.catchCause(Effect.logError)),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
      }).pipe(Effect.orDie),
  });

export default Plugin.define({
  id: "ren-ai.session-folder",
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ directory: Schema.String }),
      )(ctx.options);
      yield* sessionFolderPlugin(options.directory).effect(ctx);
    }).pipe(Effect.orDie),
});
