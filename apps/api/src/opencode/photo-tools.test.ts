import { rm } from "node:fs/promises";
import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { fakeMessages, fakeGestures } from "@ren-ai/imsg/testing";
import { personaPermissions } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import type { PhotoResult, TakePhotoInput } from "@ren-ai/plugin-application";
import { prepareMessaging } from "../application-tools.ts";
import { applicationGateway } from "./application-gateway.ts";
import {
  messagingFixture,
  registration,
  runMessagingTest,
  silentAlerts,
} from "../../test/messaging.test-helper.ts";
import { scriptedPersona } from "../../test/messaging-host.test-helper.ts";
import { startScriptedMessagingHost } from "../../test/host.test-helper.ts";
import { localOpenCode, registerApplicationPlugin } from "../../test/server.test-helper.ts";
import { remotePersonaPlugins } from "../../test/persona-plugins.test-helper.ts";

const input: TakePhotoInput = {
  scene: "My coffee by the window",
  includesMe: false,
  orientation: "portrait",
};

test.each(["taken", "declined", "failed", "send-failed", "sandbox"] as const)(
  "photo tools cross application RPC and expose real image content: %s",
  async (mode) => {
    const { root, personaDirectory } = await messagingFixture("photo-tools-");
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const llm = yield* scriptedPersona();
          const native = yield* startScriptedMessagingHost(
            root,
            personaDirectory,
            llm,
            fakeMessages().messages,
            fakeGestures().gestures,
            true,
          );
          const prepared = yield* prepareMessaging(
            native.personas,
            fakeMessages().messages,
            fakeGestures().gestures,
          );
          const takes: Array<{ sessionID: string; input: TakePhotoInput; callID: string }> = [];
          const sends: Array<{ sessionID: string; photo: string; callID: string }> = [];
          const web = applicationGateway(
            {
              ...prepared.tools,
              takePhoto: (sessionID, scene, callID) =>
                Effect.gen(function* () {
                  takes.push({ sessionID, input: scene, callID });
                  if (mode === "failed") return yield* Effect.fail(new Error("Unavailable"));
                  return mode === "declined"
                    ? ({ status: "declined" } satisfies PhotoResult)
                    : ({
                        status: "taken",
                        photo: "photo-one",
                        expiresAt: 123456,
                        data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
                      } satisfies PhotoResult);
                }),
              sendPhoto: (sessionID, photo, callID) =>
                Effect.gen(function* () {
                  sends.push({ sessionID, photo, callID });
                  if (mode === "send-failed")
                    return yield* Effect.fail(new Error("Send unavailable"));
                  return "sent";
                }),
            },
            silentAlerts,
            "photo-secret",
          );
          yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
          yield* registerApplicationPlugin(
            native,
            remotePersonaPlugins({
              url: "https://app.test/rpc",
              token: "photo-secret",
              directory: personaDirectory,
            }),
            (url, init) => web.handler(new Request(url, init)),
          );
          const remote = yield* localOpenCode(native, personaDirectory);
          const session = yield* remote.createSession("persona1");
          if (mode !== "sandbox")
            yield* prepared.directory.create(registration("photo@example.com", session.id));
          // Simulate a session persisted before the plugin rollout; root reconciliation refreshes it.
          yield* remote.client.session.update({
            sessionID: session.id,
            permissions: personaPermissions.filter(
              (rule) => !["take_photo", "send_photo"].includes(rule.action),
            ),
          });
          yield* remote.client
            .rpc(sessionFolders)
            .ensure({ folderID: session.id }, { location: { directory: personaDirectory } });
          expect((yield* remote.sessions.get(session.id)).permissions).toEqual(personaPermissions);
          let step = 0;
          yield* llm.serve((request) => {
            if (!request.tools.some((tool) => tool.name === "take_photo"))
              return TestLLM.text("Photo", "title");
            step++;
            if (step === 1) return TestLLM.tool("take-call", "take_photo", input);
            if (step === 2) return TestLLM.tool("send-call", "send_photo", { photo: "photo-one" });
            return TestLLM.text("done", "answer");
          });
          yield* remote.sessions.prompt({ sessionID: session.id, text: "Show me your coffee" });
          yield* remote.sessions.wait(session.id).pipe(Effect.timeout("10 seconds"));
          const requests = (yield* llm.requests()).filter((request) =>
            request.tools.some((tool) => tool.name === "take_photo"),
          );
          expect(requests).toHaveLength(3);
          const tools = requests[0]!.tools.map((tool) => tool.name);
          expect(tools).toContain("send_photo");
          expect(tools).not.toContain("execute");
          const content = JSON.stringify(requests[1]!.messages);
          const taken = mode === "taken" || mode === "send-failed";
          for (const marker of [
            "photo-one",
            "123456",
            '"type":"file"',
            "data:image/jpeg;base64,",
            "image/jpeg",
          ])
            expect(content.includes(marker)).toBe(taken);
          expect(content).toContain(
            taken
              ? "photo-one"
              : mode === "failed"
                ? "Application callback unavailable; request"
                : "declined",
          );
          expect(takes).toEqual(
            mode === "sandbox" ? [] : [{ sessionID: session.id, input, callID: "take-call" }],
          );
          expect(sends).toEqual(
            mode === "sandbox"
              ? []
              : [{ sessionID: session.id, photo: "photo-one", callID: "send-call" }],
          );
          expect(JSON.stringify(requests[2]!.messages)).toContain(
            mode === "sandbox"
              ? "not sent: unavailable"
              : mode === "send-failed"
                ? "Application callback unavailable; request"
                : "sent",
          );
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
