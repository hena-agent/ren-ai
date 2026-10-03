import { rm } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin/effect";
import { sessionFolderPlugin } from "@ren-ai/plugin-session-folder";
import { folderFiles } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, type Scope } from "effect";
import { messagingFixture } from "./messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "./messaging-host.test-helper.ts";
import { localOpenCode } from "./server.test-helper.ts";

const fixture = (
  root: string,
  directory: string,
  decorate: (ctx: Plugin.Context) => Plugin.Context,
) =>
  Effect.gen(function* () {
    const llm = yield* scriptedPersona();
    yield* llm.serve(() => TestLLM.text("native reply", "answer"));
    const native = yield* standaloneTestHost(root, directory, llm);
    yield* Effect.promise(() =>
      native.run(
        native.plugins.register({
          id: "ren-ai.session-folder",
          effect: (ctx) => sessionFolderPlugin(directory).effect(decorate(ctx)),
        }),
      ),
    );
    const remote = yield* localOpenCode(native, directory);
    return {
      native,
      remote,
      llm,
      rpc: remote.client.rpc(sessionFolders),
      location: { location: { directory } },
      files: folderFiles(directory),
      directory,
    };
  });

export const folderSession = (host: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const session = yield* host.remote.createSession("persona1");
    const snapshot = yield* host.rpc.read({ folderID: session.id }, host.location);
    return { session, snapshot };
  });

export const withSessionFolders = async <E>(
  run: (host: Effect.Success<ReturnType<typeof fixture>>) => Effect.Effect<void, E, Scope.Scope>,
  decorate: (ctx: Plugin.Context) => Plugin.Context = (ctx) => ctx,
) => {
  const { root, personaDirectory } = await messagingFixture("folder-lifecycle-");
  try {
    await Effect.runPromise(
      Effect.scoped(Effect.flatMap(fixture(root, personaDirectory, decorate), run)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
