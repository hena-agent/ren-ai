import { Effect, Schema } from "effect";
import { AbsolutePath, Agent, Session } from "@opencode/schema";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPersonas } from "@ren-ai/personas";
import { sessionDirectory, personaDirectory } from "@ren-ai/plugin-session-folder/paths";
import { retainedSessions } from "../conversations/retained.ts";
import { expect, test } from "vitest";
import {
  catalogTest,
  authoredDefinition,
  expectProfile,
  expectPrompt,
  beginRetainingParent,
  beginCatalogEdit,
  catalogWithoutHarin,
  expectRetainedIdentity,
} from "./catalog-sync.test-helper.ts";
import { syncFolders } from "./catalog-sync.ts";
import { unrestricted } from "../../test/host.test-helper.ts";

test(
  "catalog edits reach managed sessions while existing fork Sandboxes preserve their copies",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const parent = yield* host.metParent();
      const native = yield* host.remote.createSession("persona1");
      const fork = yield* host.nativeChild(parent, "fork");
      yield* host.ensure(fork.id);
      const forkSnapshot = yield* host.read(fork.id);
      expect(yield* host.directory.bySession(native.id)).toBeUndefined();
      expect(yield* host.directory.bySession(fork.id)).toBeUndefined();
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the orange telescope.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectProfile(host, "수아 수정");
      yield* expectPrompt(host, native.id, updated.prompt);
      yield* expectPrompt(host, fork.id, forkSnapshot.persona.prompt);
      yield* expectPrompt(host, parent.id, updated.prompt);
    }),
  ),
);

test.each(["new", "fork"] as const)(
  "a native %s copies the current retained persona folder into a Sandbox",
  (kind) =>
    catalogTest((host, fixture) =>
      Effect.gen(function* () {
        const retained = yield* beginRetainingParent(host);
        const updated = authoredDefinition({
          ...host.personas.get("persona1")!,
          name: "수아 수정",
          prompt: "You keep the red lighthouse postcard.",
        });
        yield* Effect.promise(() => fixture.store.update(updated));
        yield* host.watch();
        yield* expectProfile(host, "수아 수정");
        expect(yield* host.read(retained.parent.id)).toMatchObject({
          persona: { prompt: updated.prompt },
          relationship: retained.snapshot.relationship,
        });
        expect(yield* retained.finish).toBe("removed");
        yield* Effect.sleep("200 millis");
        const child = yield* host.nativeChild(retained.parent, kind);
        yield* expectPrompt(host, child.id, updated.prompt);
        expect((yield* host.remote.sessions.get(child.id)).location.directory).toBe(
          sessionDirectory(fixture.personaDirectory, child.id),
        );
        yield* expectRetainedIdentity(host, retained.parent.id, retained.snapshot, updated.prompt);
      }),
    )(),
);

test(
  "a Sandbox admitted during refresh preserves the copied revision while the retained session refreshes",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const retained = yield* beginRetainingParent(host);
      yield* retained.finish;
      yield* host.activeSession("persona1", "current@example.com");
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the indigo street sign.",
      });
      const gate = yield* beginCatalogEdit(host, fixture, updated);
      const child = yield* host.nativeChild(retained.parent);
      yield* host.ensure(child.id);
      expect((yield* host.read(child.id)).persona.prompt).toBe(retained.snapshot.persona.prompt);
      yield* gate.release;
      yield* expectProfile(host, "수아 수정");
      yield* expectPrompt(host, child.id, retained.snapshot.persona.prompt);
      yield* expectRetainedIdentity(host, retained.parent.id, retained.snapshot, updated.prompt);
    }),
  ),
);

test(
  "startup preserves managed shared-folder bindings and refreshes retained identity without reopening writes",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const parent = yield* host.activeSession();
      const retained = yield* retainedSessions(host.remote);
      yield* retained.retainRemoved(parent.id, "active@example.com");
      const original = yield* host.read(parent.id);
      const child = yield* host.remote.createSession("persona1");
      yield* host.remote.client.session.move({
        sessionID: child.id,
        directory: AbsolutePath.make(parent.location.directory),
      });
      yield* host.remote.sessions.wait(child.id);
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        prompt: "You like the river ferry.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      const next = yield* loadPersonas(fixture.catalogDirectory);
      yield* syncFolders(host.remote.client, fixture.personaDirectory, next, fixture.groundRules);
      expect((yield* host.remote.sessions.get(child.id)).location.directory).toBe(
        personaDirectory(fixture.personaDirectory, "persona1"),
      );
      yield* expectPrompt(host, child.id, updated.prompt);
      expect(yield* host.read(parent.id)).toMatchObject({
        persona: { prompt: updated.prompt },
        relationship: original.relationship,
        binding: original.binding,
      });
    }),
  ),
);

test(
  "moving an unrelated native session into a managed retained location applies the current catalog without another edit",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const retained = yield* beginRetainingParent(host);
      yield* retained.finish;
      const directory = join(fixture.root, "unrelated");
      yield* Effect.promise(() => mkdir(directory));
      const unrelated = yield* host.remote.client.session.create({
        agent: retained.parent.agent,
        model: retained.parent.model,
        location: { directory: AbsolutePath.make(directory) },
      });
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You collect green sea glass.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectProfile(host, "수아 수정");
      expect((yield* host.remote.sessions.get(unrelated.id)).location.directory).toBe(directory);
      yield* Effect.sleep("200 millis");
      yield* host.remote.client.session.move({
        sessionID: unrelated.id,
        directory: AbsolutePath.make(retained.parent.location.directory),
      });
      yield* host.remote.sessions.wait(unrelated.id);
      yield* expectPrompt(host, unrelated.id, updated.prompt);
      yield* expectRetainedIdentity(host, retained.parent.id, retained.snapshot, updated.prompt);
    }),
  ),
);

test(
  "an unrelated session at the legacy root is left untouched while managed native folders refresh",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const managed = yield* host.remote.createSession("persona1");
      const unrelated = yield* host.remote.client.session.create(
        unrestricted(fixture.personaDirectory),
      );
      const before = yield* host.remote.sessions.get(unrelated.id);
      const updated = new Map(host.personas);
      updated.set("persona1", {
        ...updated.get("persona1")!,
        prompt: "You draw the seaside market.",
      });
      yield* syncFolders(
        host.remote.client,
        fixture.personaDirectory,
        updated,
        fixture.groundRules,
      );
      yield* expectPrompt(host, managed.id, "You draw the seaside market.");
      expect(yield* host.remote.sessions.get(unrelated.id)).toEqual(before);
    }),
  ),
);

test(
  "an absent native persona retains her snapshot without blocking valid Catalog updates",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const harin = yield* host.remote.createSession("harin");
      const original = yield* host.read(harin.id);
      const saved = host.personas.get("harin")!;
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You grow lavender on the balcony.",
      });
      const next = yield* catalogWithoutHarin(fixture, updated);
      yield* syncFolders(host.remote.client, fixture.personaDirectory, next, fixture.groundRules);
      expect(yield* host.read(harin.id)).toEqual(original);
      expect(next.get("harin")?.published).toBe(false);
      yield* host.watch();
      yield* expectProfile(host, "수아 수정");
      yield* Effect.promise(() => fixture.store.create(saved));
      yield* expectProfile(host, "수아 수정");
      yield* expectPrompt(host, active.id, updated.prompt);
    }),
  ),
);

test(
  "a managed native session without a selected agent fails closed instead of rewriting another persona",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const original = yield* host.read(active.id);
      const id = Session.ID.create();
      const directory = yield* host.write(id, original);
      const orphan = yield* host.remote.client.session.create({
        id,
        model: active.model,
        location: { directory: AbsolutePath.make(directory) },
      });
      expect(orphan.agent).toBeUndefined();
      const updated = new Map(host.personas);
      updated.set("persona1", {
        ...updated.get("persona1")!,
        prompt: "This change requires a valid selected agent.",
      });
      expect(
        (yield* syncFolders(
          host.remote.client,
          fixture.personaDirectory,
          updated,
          fixture.groundRules,
        ).pipe(Effect.flip)).message,
      ).toContain("Cannot ensure session folder");
      expect(yield* host.read(active.id)).toEqual(original);
      yield* host.remote.client.session.switchAgent({
        sessionID: id,
        agent: Agent.ID.make("persona1"),
      });
      yield* host.remote.sessions.wait(id);
      let admitted = false;
      host.transport.after = async (request, response) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/ensure")) admitted = true;
        if (!admitted || request.method !== "GET" || path !== `/api/session/${id}`) return response;
        const { data } = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ data: Session.Info })),
        )(await response.text());
        const { agent, ...withoutAgent } = data;
        expect(agent).toBe("persona1");
        return Response.json({ data: Schema.encodeSync(Session.Info)(withoutAgent) });
      };
      expect(
        (yield* syncFolders(
          host.remote.client,
          fixture.personaDirectory,
          updated,
          fixture.groundRules,
        ).pipe(Effect.flip)).message,
      ).toContain("has no catalog persona");
      expect(yield* host.read(active.id)).toEqual(original);
      host.transport.after = (_, response) => Promise.resolve(response);
      yield* syncFolders(
        host.remote.client,
        fixture.personaDirectory,
        updated,
        fixture.groundRules,
      );
      yield* expectPrompt(host, id, "This change requires a valid selected agent.");
    }),
  ),
);

test(
  "a missing Catalog ID cannot adopt another persona's session snapshot",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const original = yield* host.read(active.id);
      yield* Effect.promise(async () => {
        await writeFile(
          join(active.location.directory, "persona.json"),
          JSON.stringify({ ...original.persona, id: "harin" }),
        );
        await writeFile(
          join(active.location.directory, ".opencode", "agents", "harin.md"),
          original.agent,
        );
      });
      const missing = new Map(host.personas);
      missing.delete("persona1");
      expect(
        (yield* syncFolders(
          host.remote.client,
          fixture.personaDirectory,
          missing,
          fixture.groundRules,
        ).pipe(Effect.flip)).message,
      ).toContain("Cannot read session folder");
      yield* Effect.promise(() =>
        writeFile(
          join(active.location.directory, ".sessions", `${active.id}.json`),
          JSON.stringify({ ...original.binding, personaID: "harin" }),
        ),
      );
      expect(
        (yield* syncFolders(
          host.remote.client,
          fixture.personaDirectory,
          missing,
          fixture.groundRules,
        ).pipe(Effect.flip)).message,
      ).toBe("Session snapshot persona ID does not match Conversation");
      expect(missing.has("persona1")).toBe(false);
      expect((yield* host.remote.sessions.get(active.id)).agent).toBe("persona1");
      expect(host.personas.get("persona1")?.prompt).toBe(original.persona.prompt);
    }),
  ),
);

test(
  "maintenance reconciles native sessions created after the Catalog revision from its durable cache",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const retained = yield* beginRetainingParent(host);
      yield* retained.finish;
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You have the cobalt blue notebook.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.refresh;
      yield* expectProfile(host, "수아 수정");
      const child = yield* host.nativeChild(retained.parent);
      yield* host.reconcile;
      expect((yield* host.remote.sessions.get(child.id)).location.directory).toBe(
        sessionDirectory(fixture.personaDirectory, child.id),
      );
      yield* expectPrompt(host, child.id, updated.prompt);
      yield* expectRetainedIdentity(host, retained.parent.id, retained.snapshot, updated.prompt);
    }),
  ),
);
