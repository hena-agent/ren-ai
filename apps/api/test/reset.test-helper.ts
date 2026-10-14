import { randomUUID } from "node:crypto";
import { rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import { discoveryNotice } from "@ren-ai/onboarding";
import type { Messages } from "@ren-ai/imsg";
import { Session } from "@opencode/schema/session";
import { expect } from "vitest";
import { contacts } from "../src/discovery/contacts.ts";
import { makeDiscoveryWeb } from "../src/discovery/discovery.ts";
import { firstContacts } from "../src/discovery/first-contact.ts";
import { messagingFixture, registration, runMessagingTest } from "./messaging.test-helper.ts";
import { quietTestHost, startTestHost } from "./messaging-host.test-helper.ts";
import { fakeMessages } from "@ren-ai/imsg/testing";

export const resetFixture = async (prefix: string) => {
  const fixture = await messagingFixture(prefix);
  await copyFile(
    join(fixture.personaDirectory, "persona1.md"),
    join(fixture.personaDirectory, "persona2.md"),
  );
  const fake = fakeMessages();
  const start = quietTestHost(
    fixture.root,
    fixture.personaDirectory,
    fake.messages,
    join(fixture.root, "opencode.sqlite"),
  );
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

const verified = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
);

/** How a test handle starts over after `/reset`: register through Discovery, then start it directly. */
export const startTestHandle = (
  host: Host,
  messages: Pick<Messages, "textStatus">,
  handle: string,
  personaID = "persona1",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const catalog = async () =>
      [...host.personas.values()].map((persona) => ({
        id: persona.id,
        name: persona.id,
        bio: "public",
        imageUrl: "",
      }));
    const discovery = yield* makeDiscoveryWeb({ catalog, turnstileSecret: "test" });
    yield* Effect.addFinalizer(() => Effect.promise(discovery.dispose));
    const joined = yield* Effect.promise(() =>
      discovery.handler(
        new Request("http://api.test/discovery/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            handle,
            locale: "ko",
            privacyNoticeVersion: discoveryNotice.version,
            turnstileToken: "human",
            likedPersonaIDs: [personaID],
          }),
        }),
        Context.make(HttpClient.HttpClient, verified),
      ),
    );
    expect(joined.status).toBe(200);
    const [registered] = yield* sql<{
      id: string;
    }>`SELECT id FROM discovery_registration WHERE handle = ${handle}`;
    if (!registered) return "unavailable" as const;
    const store = yield* contacts(catalog);
    const started = yield* store.start(
      { requestId: randomUUID(), registrationID: registered.id, personaID },
      randomUUID(),
    );
    if (!started) return "unavailable" as const;
    const first = yield* firstContacts(host, messages, host.conversations, "test/probe", () => {});
    yield* first.tick;
    return "started" as const;
  });

export const bindTestHandle = (host: Host, handle: string, personaID = "persona1") =>
  Effect.gen(function* () {
    const session = yield* host.createSession(personaID);
    yield* host.conversations.create({ ...registration(handle, session.id), personaID });
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
