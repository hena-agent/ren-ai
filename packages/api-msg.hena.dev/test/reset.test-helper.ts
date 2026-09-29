import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { Session } from "@opencode/schema/session";
import {
  messagingFixture,
  quietTestHost,
  registration,
  runMessagingTest,
  startTestHost,
} from "./messaging-host.test-helper.ts";
import { fakeMessages } from "../src/messages/messages.fake.ts";

export const resetFixture = async (prefix: string) => {
  const fixture = await messagingFixture(prefix);
  const fake = fakeMessages();
  const start = Effect.gen(function* () {
    const host = yield* quietTestHost(
      fixture.root,
      fixture.personaDirectory,
      fake.messages,
      join(fixture.root, "opencode.sqlite"),
    );
    yield* Effect.addFinalizer(() => Effect.promise(host.disposeOnboarding));
    return host;
  });
  return {
    ...fixture,
    fake,
    handle: "tester@example.com",
    start,
    startMarked: start.pipe(Effect.tap((host) => bindTestHandle(host, "tester@example.com"))),
    run: <A, E>(body: Parameters<typeof runMessagingTest<A, E>>[0]) =>
      runMessagingTest(body, join(fixture.root, "server.sqlite")),
    cleanup: () => rm(fixture.root, { recursive: true, force: true }),
  };
};

type Host = Effect.Success<ReturnType<typeof startTestHost>>;

export const bindTestHandle = (host: Host, handle: string) =>
  Effect.gen(function* () {
    const session = yield* host.createSession("persona1");
    yield* host.conversations.create(registration(handle, session.id));
    yield* host.operator.testHandle(handle, true);
    return session;
  });

export const currentMemory = (host: Host, handle: string) =>
  Effect.gen(function* () {
    const conversation = yield* host.conversations.byHandle(handle);
    if (!conversation) throw new Error(`Missing Conversation for ${handle}`);
    const id = Session.ID.make(conversation.sessionID);
    yield* host.sessions.wait(id);
    return { id, text: JSON.stringify(yield* host.sessions.messages({ sessionID: id })) };
  });
