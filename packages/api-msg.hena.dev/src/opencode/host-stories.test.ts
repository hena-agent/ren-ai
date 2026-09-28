import { TestLLM } from "@opencode/ai/testing";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";
import { fakeGestures } from "../gestures/gestures.fake.ts";
import { fakeMessages } from "../messages/messages.fake.ts";
import {
  bindConversation,
  personaFixture,
  startScriptedMessagingHost,
  valid,
} from "../../test/host.test-helper.ts";
import { mediaFixtures } from "../../test/media.test-helper.ts";

test("the real host gives the scripted model a downscaled HEIC photo", async () => {
  const { root, personaDirectory, cleanup } = await personaFixture("host-photo-", valid);
  const fake = fakeMessages();
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
    "base64",
  );
  const fixture = mediaFixtures(jpeg);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* Effect.provide(TestLLM.Test, TestLLM.testLayer());
          yield* llm.serve(() => TestLLM.text("done", "answer"));
          const host = yield* startScriptedMessagingHost(
            root,
            personaDirectory,
            llm,
            fake.messages,
            fakeGestures().gestures,
            true,
          );
          const session = yield* host.createSession("persona1");
          yield* bindConversation(host, "photo@example.com", session.id);
          yield* fake.text("photo@example.com", "look", Date.now(), {
            attachments: [
              {
                path: "/private/Messages/photo.heic",
                mimeType: "image/heic",
                uti: null,
                missing: false,
              },
            ],
          });
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("20 seconds"));
          expect(fixture.commands).toEqual([
            [
              "/usr/bin/sips",
              "-s",
              "format",
              "jpeg",
              "-Z",
              "1600",
              "/private/Messages/photo.heic",
              "--out",
              "/test-temp/photo.jpeg",
            ],
          ]);
          const request = JSON.stringify((yield* llm.requests())[0]?.messages);
          expect(request).toContain("<photo at=");
          expect(request).toContain(jpeg.toString("base64"));
          expect(request).not.toContain("/private/Messages/photo.heic");
        }).pipe(
          Effect.provide(Layer.merge(SqliteClient.layer({ filename: ":memory:" }), fixture.layer)),
        ),
      ),
    );
  } finally {
    await cleanup();
  }
}, 30000);

test("reading and silence end turns without sending a bubble", async () => {
  const { root, personaDirectory, cleanup } = await personaFixture("host-silence-", valid);
  const fake = fakeMessages();
  const ui = fakeGestures();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const llm = yield* Effect.provide(TestLLM.Test, TestLLM.testLayer());
          let step = 0;
          yield* llm.serve((request) => {
            if (!request.tools.some((tool) => tool.name === "read"))
              return TestLLM.text("title", "title");
            return step++ === 0
              ? TestLLM.tool("read-call", "read", {})
              : TestLLM.text("done", "answer");
          });
          const host = yield* startScriptedMessagingHost(
            root,
            personaDirectory,
            llm,
            fake.messages,
            ui.gestures,
          );
          const session = yield* host.createSession("persona1");
          yield* bindConversation(host, "quiet@example.com", session.id);
          yield* fake.text("quiet@example.com", "first", Date.now());
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("20 seconds"));
          expect(ui.reads).toEqual(["quiet@example.com"]);
          expect(fake.bubbles).toEqual([]);
          expect(
            JSON.stringify(yield* host.sessions.messages({ sessionID: session.id })),
          ).toContain('"text":"read"');
          yield* fake.text("quiet@example.com", "second", Date.now());
          yield* host.sessions.wait(session.id).pipe(Effect.timeout("20 seconds"));
          expect(ui.reads).toHaveLength(1);
          expect(fake.bubbles).toEqual([]);
          expect((yield* llm.requests()).at(-1)?.tools.map((tool) => tool.name)).toContain("send");
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
      ),
    );
  } finally {
    await cleanup();
  }
}, 30000);
