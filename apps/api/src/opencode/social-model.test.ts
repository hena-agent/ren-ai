import { rm } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test, vi } from "vitest";
import installedPlugin from "@ren-ai/plugin-session-folder";
import { socialPermissions, renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { personaMemory } from "@ren-ai/plugin-session-folder/memory";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { socialModel } from "../../../social/src/model.ts";
import { Session } from "@opencode/schema/session";
import { socialTask } from "../../../../packages/onboarding/src/social.test-helper.ts";
import { messagingFixture } from "../../test/messaging.test-helper.ts";
import {
  scriptedPersona,
  standaloneTestHost,
  providerUnavailable,
} from "../../test/messaging-host.test-helper.ts";
import { localOpenCode } from "../../test/server.test-helper.ts";
import { registerInstalledPlugin } from "../../test/persona-plugins.test-helper.ts";

test("real OpenCode social sessions share the Persona's life but isolate public, private and iMessage memories and tools", async () => {
  const { root, personaDirectory } = await messagingFixture("social-model-");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          let output = JSON.stringify({ action: { kind: "finish" }, reason: "Done" });
          let fail = false;
          yield* llm.serve(() =>
            fail ? providerUnavailable("private provider reason") : TestLLM.text(output, "answer"),
          );
          const native = yield* standaloneTestHost(root, personaDirectory, llm);
          yield* registerInstalledPlugin(native, installedPlugin, { directory: personaDirectory });
          const remote = yield* localOpenCode(native, personaDirectory);
          const task = socialTask();
          const persona = native.personas.get("persona1")!;
          const selected = {
            ...task,
            account: { ...task.account, personaId: persona.id },
            snapshot: JSON.stringify(renderSnapshot(persona, "Ground rules")),
          };
          let hideMessages = false;
          let losePrompt = false;
          let promptResponse: Response | undefined;
          const network: typeof fetch = async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (losePrompt && path.endsWith("/prompt") && promptResponse)
              return promptResponse.clone();
            const response = await native.web(request);
            if (path.endsWith("/prompt")) promptResponse = response.clone();
            if (hideMessages && request.method === "GET" && path.includes("/message")) {
              const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
                await response.json(),
              );
              return Response.json({ ...body, data: [] });
            }
            return response;
          };
          const model = socialModel(
            {
              url: "https://oc.test",
              authorization: "Basic test",
              directory: personaDirectory,
              model: "test/probe",
            },
            network,
          );
          expect(
            yield* Effect.promise(() =>
              model.decide(selected, task.run, "public observation", new AbortController().signal),
            ),
          ).toMatchObject({ action: { kind: "finish" } });
          const location = { location: { directory: personaDirectory } };
          const inventory = yield* remote.client.rpc(sessionFolders).inventory({}, location);
          const publicID = Session.ID.make(
            Object.entries(inventory[0]!.bindings).find(
              ([, binding]) => binding.social?.contact === null,
            )![0],
          );
          expect((yield* remote.sessions.get(publicID)).permissions).toEqual(socialPermissions);
          const publicSnapshot = yield* remote.client
            .rpc(sessionFolders)
            .read({ folderID: publicID }, { location: { directory: personaDirectory } });
          const publicDirectory = (yield* remote.sessions.get(publicID)).location.directory;
          const privateRun = { ...task.run, contact: "reader", step: 1 };
          expect(
            yield* Effect.promise(() =>
              model.decide(
                selected,
                privateRun,
                "private observation",
                new AbortController().signal,
              ),
            ),
          ).toMatchObject({ action: { kind: "finish" } });
          const privateScopes = yield* remote.client.rpc(sessionFolders).inventory({}, location);
          const privateID = Session.ID.make(
            Object.entries(privateScopes[0]!.bindings).find(
              ([, binding]) => binding.social?.contact === "reader",
            )![0],
          );
          const privateMemory = personaMemory(publicDirectory, privateID);
          yield* Effect.promise(() =>
            privateMemory.run(
              "update_memory",
              {
                scope: "relationship",
                markdown: "PRIVATE_READER_FACT",
                reason: "Private conversation",
              },
              "private-memory",
              "test",
            ),
          );
          expect(
            yield* Effect.promise(() => personaMemory(publicDirectory, publicID).context()),
          ).not.toContain("PRIVATE_READER_FACT");
          const other = yield* remote.createSession(persona.id);
          expect(
            yield* Effect.promise(() => personaMemory(publicDirectory, other.id).context()),
          ).not.toContain("PRIVATE_READER_FACT");
          const requests = yield* llm.requests();
          const socialRequests = requests.filter(
            (request) =>
              JSON.stringify(request).includes("public observation") ||
              JSON.stringify(request).includes("private observation"),
          );
          expect(socialRequests.length).toBeGreaterThanOrEqual(2);
          for (const request of socialRequests) {
            expect(request.tools.map((tool) => tool.name)).not.toContain("send");
            expect(request.tools.map((tool) => tool.name)).not.toContain("wait");
            expect(request.tools.map((tool) => tool.name)).not.toContain("bash");
          }
          yield* Effect.promise(() => model.interrupt(selected, privateRun));
          expect(publicSnapshot.binding?.social).toEqual({
            accountID: task.account.id,
            contact: null,
          });
          const wrong = {
            ...publicSnapshot,
            binding: {
              ...publicSnapshot.binding!,
              social: { accountID: task.account.id, contact: "wrong" },
            },
          };
          const mismatch = yield* remote.client
            .rpc(sessionFolders)
            .create({ folderID: publicID, snapshot: wrong, model: "test/probe" }, location)
            .pipe(Effect.flip);
          expect(JSON.stringify(mismatch)).toContain("social scope does not match");
          const changed = yield* remote.client
            .rpc(sessionFolders)
            .write({ folderID: publicID, snapshot: wrong }, location)
            .pipe(Effect.flip);
          expect(JSON.stringify(changed)).toContain("social binding cannot change");
          output = "not JSON";
          yield* Effect.promise(async () => {
            await expect(
              model.decide(
                selected,
                { ...task.run, step: 2 },
                "new observation",
                new AbortController().signal,
              ),
            ).rejects.toThrow("Invalid structured");
          });
          losePrompt = true;
          yield* Effect.promise(async () => {
            await expect(
              model.decide(
                selected,
                { ...task.run, step: 3 },
                "lost prompt",
                new AbortController().signal,
              ),
            ).rejects.toThrow("did not complete");
          });
          losePrompt = false;
          hideMessages = true;
          yield* Effect.promise(async () => {
            await expect(
              model.decide(
                selected,
                { ...task.run, step: 4 },
                "hidden response",
                new AbortController().signal,
              ),
            ).rejects.toThrow("did not complete");
          });
          hideMessages = false;
          fail = true;
          yield* Effect.promise(async () => {
            await expect(
              model.decide(
                selected,
                { ...task.run, step: 5 },
                "provider down",
                new AbortController().signal,
              ),
            ).rejects.toThrow("did not complete");
          });
          const original = globalThis.fetch;
          const mock = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation((input, init) =>
              new URL(new Request(input, init).url).hostname === "oc.test"
                ? network(input, init)
                : original(input, init),
            );
          try {
            yield* Effect.promise(() =>
              socialModel({
                url: "https://oc.test",
                authorization: "Basic test",
                directory: personaDirectory,
                model: "test/probe",
              }).interrupt(selected, privateRun),
            );
          } finally {
            mock.mockRestore();
          }
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
