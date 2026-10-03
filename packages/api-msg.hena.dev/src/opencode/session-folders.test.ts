import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { Session } from "@opencode/schema";
import { expect, test } from "vitest";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import installedPlugin from "@ren-ai/plugin-session-folder";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { messagingFixture } from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { localOpenCode } from "../../test/server.test-helper.ts";
import { registerInstalledPlugin } from "../../test/persona-plugins.test-helper.ts";

const reject = (effect: Effect.Effect<object | string | void | null, object>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => JSON.stringify(error)),
  );

test("every folder RPC schema is opaque to the compiled CLI's separate Effect instance", () => {
  const schemas = [
    ...Object.values(sessionFolders.methods).flatMap((method) => [
      method.input,
      method.output,
      ...Object.values(method.errors),
    ]),
    ...Object.values(sessionFolders.events).map((event) => event.schema),
  ];
  for (const schema of schemas) {
    expect(Schema.isSchema(schema)).toBe(false);
    expect(Object.keys(schema)).toEqual(["~standard"]);
  }
});

test("folder RPC scopes files, preserves identity, and reloads native persona instructions", async () => {
  const { root, personaDirectory } = await messagingFixture("session-folders-");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          yield* llm.serve(() => TestLLM.text("hello", "reply"));
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          yield* registerInstalledPlugin(native, installedPlugin, { directory: personaDirectory });
          const remote = yield* localOpenCode(native, personaDirectory);
          const rpc = remote.client.rpc(sessionFolders);
          const location = { location: { directory: personaDirectory } };
          expect(yield* remote.createSession("absent").pipe(Effect.flip)).toEqual(
            new Error("Unknown persona: absent"),
          );
          expect(
            yield* remote.sessions.remove(Session.ID.make("ses/../invalid")).pipe(Effect.flip),
          ).toBeInstanceOf(Error);
          const session = yield* remote.createSession("persona1");
          const other = yield* remote.createSession("persona1");
          const old = yield* rpc.read({ folderID: session.id }, location);
          yield* remote.sessions.prompt({ sessionID: session.id, text: "First meeting" });
          yield* remote.sessions.wait(session.id);
          expect(yield* reject(rpc.remove({ folderID: session.id }, location))).toContain(
            "Remove the session",
          );
          expect(yield* reject(rpc.read({ folderID: "ses_missing" }, location))).toContain(
            "Cannot read",
          );
          expect(
            yield* reject(rpc.write({ folderID: "../escape", snapshot: old }, location)),
          ).toContain("invalid_input");
          expect(
            yield* reject(
              rpc.write(
                {
                  folderID: session.id,
                  snapshot: renderSnapshot({ ...old.persona, id: "different" }, "rules"),
                },
                location,
              ),
            ),
          ).toContain("cannot change");
          const updated = renderSnapshot(
            { ...old.persona, prompt: "You are a quiet photographer." },
            "Always remember the blue umbrella.",
          );
          yield* rpc.write({ folderID: session.id, snapshot: updated }, location);
          expect(yield* rpc.read({ folderID: other.id }, location)).toEqual(old);
          yield* Effect.promise(async () => {
            await expect
              .poll(
                async () => {
                  const agents = await Effect.runPromise(
                    remote.client.agent.list({ location: session.location }),
                  );
                  return agents.data.find((agent) => agent.id === "persona1")?.system;
                },
                { timeout: 5000 },
              )
              .toBe("You are a quiet photographer.");
          });
          yield* Effect.promise(async () => {
            await expect
              .poll(
                async () => {
                  await Effect.runPromise(
                    remote.sessions.prompt({ sessionID: session.id, text: "Hello" }),
                  );
                  await Effect.runPromise(remote.sessions.wait(session.id));
                  return JSON.stringify(await Effect.runPromise(llm.requests()));
                },
                { timeout: 5000 },
              )
              .toContain("blue umbrella");
          });
          const requests = JSON.stringify(yield* llm.requests());
          expect(requests).toContain("quiet photographer");
          expect(requests).toContain("blue umbrella");
          const unchanged = awaitFile(join(other.location.directory, "AGENTS.md"));
          expect(yield* unchanged).not.toContain("blue umbrella");
          yield* remote.sessions.remove(session.id);
          yield* remote.sessions.remove(session.id);
          expect(yield* reject(rpc.read({ folderID: session.id }, location))).toContain(
            "Cannot read",
          );
          yield* remote.client.session.remove({ sessionID: other.id });
          yield* Effect.promise(async () => {
            await expect
              .poll(async () => {
                const result = await Effect.runPromise(
                  rpc.read({ folderID: other.id }, location).pipe(Effect.result),
                );
                return Result.isFailure(result);
              })
              .toBe(true);
          });

          const blocked = join(personaDirectory, "sessions", "ses_blocked");
          yield* Effect.promise(() => symlink(root, blocked));
          expect(
            yield* reject(rpc.write({ folderID: "ses_blocked", snapshot: old }, location)),
          ).toContain("real directory");
          const broken = join(personaDirectory, "sessions", "ses_broken");
          yield* Effect.promise(() => mkdir(broken));
          for (const file of ["persona.json", "AGENTS.md"]) {
            const occupied = join(broken, file);
            yield* Effect.promise(() => mkdir(occupied));
            expect(
              yield* reject(rpc.write({ folderID: "ses_broken", snapshot: old }, location)),
            ).toContain("Cannot write");
            yield* Effect.promise(() => rm(occupied, { recursive: true }));
          }
          yield* Effect.promise(async () => {
            await rm(join(personaDirectory, "sessions"), { recursive: true });
            await symlink(root, join(personaDirectory, "sessions"));
          });
          expect(yield* remote.createSession("persona1").pipe(Effect.flip)).toEqual(
            new Error("Cannot create persona session"),
          );
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const awaitFile = (path: string) => Effect.promise(() => readFile(path, "utf8"));
