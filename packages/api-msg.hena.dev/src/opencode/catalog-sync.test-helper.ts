import { Deferred, Effect, Fiber, type Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Session } from "@opencode/schema";
import { SessionMessage } from "@opencode/schema/session-message";
import type { SqlClient } from "effect/unstable/sql";
import { TestLLM } from "@opencode/ai/testing";
import { createPersonaStore, loadPersonas, type PersonaRecord } from "@ren-ai/personas";
import { folderSnapshot, sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { expect } from "vitest";
import { migrate } from "../database.ts";
import { conversations } from "../conversations/conversations.ts";
import { rebuilder } from "../conversations/rebuild-session.ts";
import { retainedSessions } from "../conversations/retained.ts";
import { makeOperator } from "../operator/operator.ts";
import { intake } from "../intake/intake.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";
import { catalogAPI } from "../onboarding/catalog.test-helper.ts";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { remoteHost } from "./remote.ts";
import { watchCatalog } from "./catalog-sync.ts";

const catalogFixture = async () => {
  const fixture = await messagingFixture("catalog-sync-");
  const definitions = await createPersonaStore(fixture.personaDirectory);
  const persona = {
    ...(await definitions.get("persona1")),
    name: "수아",
    bio: "24살 대학생",
    published: true,
  };
  await definitions.update(persona);
  await definitions.create({
    ...persona,
    id: "harin",
    name: "하린",
    bio: "29살 서울 사진가",
    prompt: "You are Harin.",
  });
  const catalogDirectory = join(fixture.root, "catalog");
  const store = await createPersonaStore(catalogDirectory);
  for (const record of await definitions.list()) await store.create(record);
  return { ...fixture, catalogDirectory, store };
};

const catalogHost = (fixture: Awaited<ReturnType<typeof catalogFixture>>) =>
  Effect.gen(function* () {
    yield* migrate;
    const llm = yield* scriptedPersona();
    yield* llm.serve(() => TestLLM.text("hello", "answer"));
    const native = yield* standaloneTestHost(fixture.root, fixture.personaDirectory, llm);
    const directory = yield* conversations;
    const personas = yield* loadPersonas(fixture.catalogDirectory);
    const transport: {
      before: (request: Request) => Promise<void>;
      after: (request: Request, response: Response) => Promise<Response>;
    } = {
      before: () => Promise.resolve(),
      after: (_, response) => Promise.resolve(response),
    };
    const remote = yield* remoteHost(
      {
        baseUrl: "https://oc.test",
        authorization: "Basic test",
        directory: fixture.personaDirectory,
        model: "test/probe",
      },
      personas,
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
        const request = new Request(input, init);
        await transport.before(request.clone());
        return transport.after(request, await native.web(request));
      }),
    );
    const api = yield* catalogAPI(personas, "persona1", {
      createSession: remote.createSession,
      prompt: (sessionID, text) =>
        remote.sessions.prompt({ sessionID: Session.ID.make(sessionID), text }).pipe(Effect.asVoid),
    });
    const incoming = yield* intake(
      api.fake.messages,
      directory.byHandle,
      (sessionID, id, text, files) =>
        directory.admit(
          sessionID,
          remote.sessions
            .prompt({
              sessionID: Session.ID.make(sessionID),
              id: SessionMessage.ID.make(id),
              text,
              files,
            })
            .pipe(Effect.asVoid),
        ),
      (id) => personas.get(id)!.timeZone,
      undefined,
      undefined,
      undefined,
      false,
    );
    const recovery = yield* rebuilder(directory, remote, noticeCopy, incoming.replay);
    const rpc = remote.client.rpc(sessionFolders);
    const location = { location: { directory: fixture.personaDirectory } };
    const read = (folderID: string) => rpc.read({ folderID }, location);
    const write = (folderID: string, snapshot: typeof folderSnapshot.Type) =>
      rpc.write({ folderID, snapshot }, location);
    const ensure = (folderID: string) => rpc.ensure({ folderID }, location);
    const nativeChild = (parent: Session.Info, kind: "new" | "fork" = "new") =>
      kind === "fork"
        ? remote.client.session.fork({ sessionID: parent.id })
        : remote.client.session.create({
            agent: parent.agent,
            model: parent.model,
            location: parent.location,
          });
    const metParent = () =>
      Effect.gen(function* () {
        const parent = yield* activeSession();
        yield* remote.sessions.prompt({
          sessionID: parent.id,
          text: "Remember our first conversation.",
        });
        yield* remote.sessions.wait(parent.id);
        return parent;
      });
    const activeSession = (personaID = "persona1", handle = "active@example.com") =>
      Effect.gen(function* () {
        const session = yield* remote.createSession(personaID);
        yield* directory.create({
          handle,
          locale: "ko",
          consentVersion: "v1",
          consentLanguage: "ko",
          personaID,
          sessionID: session.id,
        });
        return session;
      });
    const watch = () =>
      Effect.forkScoped(
        watchCatalog(remote.client, fixture.personaDirectory, fixture.catalogDirectory, personas),
      );
    const profileName = () =>
      api
        .list()
        .pipe(Effect.map((list) => list.find((persona) => persona.id === "persona1")?.name));
    return {
      remote,
      personas,
      api,
      llm,
      read,
      write,
      ensure,
      nativeChild,
      metParent,
      activeSession,
      directory,
      watch,
      profileName,
      transport,
      recovery,
    };
  });

type Host = Effect.Success<ReturnType<typeof catalogHost>>;
type Fixture = Awaited<ReturnType<typeof catalogFixture>>;

export const catalogTest =
  <E>(
    scenario: (
      host: Host,
      fixture: Fixture,
    ) => Effect.Effect<void, E, SqlClient.SqlClient | Scope.Scope>,
  ) =>
  async () => {
    const fixture = await catalogFixture();
    try {
      await runMessagingTest(
        Effect.gen(function* () {
          const host = yield* catalogHost(fixture);
          yield* scenario(host, fixture);
        }),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 3 });
    }
  };

export const expectPrompt = (host: Host, sessionID: string, prompt: string) =>
  Effect.promise(async () => {
    await expect
      .poll(async () => (await Effect.runPromise(host.read(sessionID))).persona.prompt, {
        timeout: 4000,
      })
      .toBe(prompt);
  });

export const expectProfile = (host: Host, name: string) =>
  Effect.promise(async () => {
    await expect.poll(() => Effect.runPromise(host.profileName()), { timeout: 4000 }).toBe(name);
  });

const pauseRequest = (host: Host, matches: (request: Request) => Promise<boolean>) =>
  Effect.gen(function* () {
    const { entered, release } = yield* barrier;
    host.transport.before = async (request) => {
      if (!(await matches(request))) return;
      host.transport.before = () => Promise.resolve();
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(release));
    };
    return {
      entered: Deferred.await(entered).pipe(Effect.timeout("5 seconds")),
      release: Deferred.succeed(release, undefined),
    };
  });

export const pauseFolderWrite = (host: Host, prompt: string) =>
  pauseRequest(
    host,
    async (request) =>
      request.method === "POST" &&
      /\/api\/rpc\/ren-ai\.session-folders\/(write|update|create)$/.test(
        new URL(request.url).pathname,
      ) &&
      (await request.text()).includes(prompt),
  );

export const pauseGreeting = (host: Host) =>
  pauseRequest(host, (request) =>
    Promise.resolve(request.method === "POST" && new URL(request.url).pathname.endsWith("/prompt")),
  );

const pauseSessionLookup = (host: Host, id: string) =>
  pauseRequest(host, (request) =>
    Promise.resolve(
      request.method === "GET" && new URL(request.url).pathname === `/api/session/${id}`,
    ),
  );

export const beginRetainingParent = (host: Host) =>
  Effect.gen(function* () {
    const parent = yield* host.metParent();
    const snapshot = yield* host.read(parent.id);
    const operator = yield* markedOperator(host);
    const gate = yield* pauseSessionLookup(host, parent.id);
    const removing = yield* operator.remove("active@example.com").pipe(Effect.forkScoped);
    yield* gate.entered;
    const finish = Effect.gen(function* () {
      yield* gate.release;
      return yield* Fiber.join(removing);
    });
    return { parent, snapshot, finish };
  });

export const markedOperator = (host: Host) =>
  Effect.gen(function* () {
    const retained = yield* retainedSessions(host.remote);
    const operator = yield* makeOperator(
      host.directory,
      (id) => host.remote.sessions.remove(Session.ID.make(id)),
      undefined,
      retained.retainRemoved,
    );
    yield* operator.testHandle("active@example.com", true);
    return operator;
  });

export const beginCatalogEdit = (host: Host, fixture: Fixture, updated: PersonaRecord) =>
  Effect.gen(function* () {
    const gate = yield* pauseFolderWrite(host, updated.prompt);
    yield* Effect.promise(() => fixture.store.update(updated));
    yield* host.watch();
    yield* gate.entered;
    return gate;
  });

export const catalogWithoutHarin = (fixture: Fixture, updated: PersonaRecord) =>
  Effect.gen(function* () {
    yield* Effect.promise(async () => {
      await fixture.store.update(updated);
      await rm(join(fixture.catalogDirectory, "harin.md"));
    });
    return yield* loadPersonas(fixture.catalogDirectory);
  });

export const barrier = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  return { entered, release };
});

export const editDuringAllocation = (
  host: Host,
  fixture: Fixture,
  gate: Pick<Effect.Success<ReturnType<typeof pauseFolderWrite>>, "release">,
  updated: PersonaRecord,
) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => fixture.store.update(updated));
    yield* host.watch();
    yield* Effect.sleep("200 millis");
    expect(yield* host.profileName()).toBe("수아");
    yield* gate.release;
  });

export const expectBoundPersona = (host: Host, handle: string, persona: PersonaRecord) =>
  Effect.gen(function* () {
    yield* expectProfile(host, persona.name);
    const conversation = (yield* host.directory.byHandle(handle))!;
    yield* expectPrompt(host, conversation.sessionID, persona.prompt);
  });
