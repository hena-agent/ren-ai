import { randomUUID } from "node:crypto";
import { rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { discoveryNotice } from "@ren-ai/onboarding";
import type { Messages } from "@ren-ai/imsg";
import { Session } from "@opencode/schema/session";
import { expect } from "vitest";
import { contacts } from "../src/discovery/contacts.ts";
import { makeDiscoveryWeb } from "../src/discovery/discovery.ts";
import { firstContacts } from "../src/discovery/first-contact.ts";
import { checkAvailability } from "../src/discovery/availability.ts";
import { messagingFixture, registration, runMessagingTest } from "./messaging.test-helper.ts";
import { quietTestHost, startTestHost } from "./messaging-host.test-helper.ts";
import { fakeMessages } from "@ren-ai/imsg/testing";

export const resetFixture = async (prefix: string) => {
  const fixture = await messagingFixture(prefix);
  await copyFile(
    join(fixture.personaDirectory, "persona1.md"),
    join(fixture.personaDirectory, "persona2.md"),
  );
  await copyFile(
    join(fixture.personaDirectory, "persona1.md"),
    join(fixture.personaDirectory, "persona3.md"),
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
    handle: "+821012345678",
    start,
    startMarked: start.pipe(Effect.tap((host) => bindTestHandle(host, "+821012345678"))),
    run: <A, E>(body: Parameters<typeof runMessagingTest<A, E>>[0]) =>
      runMessagingTest(body, join(fixture.root, "server.sqlite")),
    cleanup: () => rm(fixture.root, { recursive: true, force: true }),
  };
};

type Host = Effect.Success<ReturnType<typeof startTestHost>>;

const verified = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
);

/** Reselect an unused Persona through the ending's private link, then use test-handle Selection. */
export const startTestHandle = (
  host: Host,
  messages: Pick<Messages, "textStatus" | "availability">,
  handle: string,
  personaID?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (yield* host.conversations.byHandle(handle)) return "unavailable" as const;
    yield* host.heartbeat.stopped;
    const used = yield* sql<{
      id: string;
    }>`SELECT COALESCE(c.persona_id, u.persona_id) AS id FROM user u LEFT JOIN conversation c ON c.user_id = u.id
      UNION SELECT persona_id AS id FROM persona_assignment`;
    const target =
      personaID ?? [...host.personas.keys()].find((id) => !used.some((row) => row.id === id));
    if (!target) return "unavailable" as const;
    const [ending] = yield* sql<{
      notice: string;
    }>`SELECT e.notice FROM conversation_end e JOIN conversation c ON c.id = e.conversation_id
      JOIN user u ON u.id = c.user_id WHERE u.handle = ${handle} ORDER BY c.id DESC LIMIT 1`;
    const reselectionToken =
      ending && new URL(ending.notice.split("\n").at(-1)!).hash.slice("#reselect=".length);
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
            name: "Visitor",
            likedPersonaIDs: [target],
            ...(reselectionToken && { reselectionToken }),
          }),
        }),
        Context.make(HttpClient.HttpClient, verified),
      ),
    );
    expect(joined.status).toBe(200);
    const [registered] = yield* sql<{
      id: string;
    }>`SELECT id FROM discovery_registration WHERE handle = ${handle} AND archived_at IS NULL`;
    if (!registered) return "unavailable" as const;
    yield* checkAvailability(
      registered.id,
      {
        availability: (address) =>
          messages
            .availability(address)
            .pipe(Effect.map((result) => ({ ...result, requestId: randomUUID() }))),
      },
      () => {},
    );
    const store = yield* contacts(catalog);
    const started = yield* store.start(
      { requestId: randomUUID(), registrationID: registered.id, personaID: target },
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
