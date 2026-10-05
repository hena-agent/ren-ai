import { Deferred, Effect, Schema } from "effect";
import { AbsolutePath, Agent, Session } from "@opencode/schema";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadPersonas } from "@ren-ai/personas";
import { sessionDirectory } from "@ren-ai/plugin-session-folder/paths";
import { retainedSessions } from "../conversations/retained.ts";
import { expect, test } from "vitest";
import {
  catalogTest,
  expectProfile,
  expectPrompt,
  beginRetainingParent,
  beginCatalogEdit,
  catalogWithoutHarin,
} from "./catalog-sync.test-helper.ts";
import { syncFolders } from "./catalog-sync.ts";
import { unrestricted } from "../../test/host.test-helper.ts";

test(
  "catalog edits reach managed native sessions and forks even without application conversations",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const parent = yield* host.metParent();
      const native = yield* host.remote.createSession("persona1");
      const fork = yield* host.nativeChild(parent, "fork");
      yield* host.ensure(fork.id);
      expect(yield* host.directory.bySession(native.id)).toBeUndefined();
      expect(yield* host.directory.bySession(fork.id)).toBeUndefined();
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the orange telescope.",
      };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectProfile(host, "수아 수정");
      yield* expectPrompt(host, native.id, updated.prompt);
      yield* expectPrompt(host, fork.id, updated.prompt);
      yield* expectPrompt(host, parent.id, updated.prompt);
    }),
  ),
);

test.each(["new", "fork"] as const)(
  "a native %s from a retained folder follows the live catalog while pending removal and retained parents stay frozen",
  (kind) =>
    catalogTest((host, fixture) =>
      Effect.gen(function* () {
        const retained = yield* beginRetainingParent(host);
        const updated = {
          ...host.personas.get("persona1")!,
          name: "수아 수정",
          prompt: "You keep the red lighthouse postcard.",
        };
        yield* Effect.promise(() => fixture.store.update(updated));
        yield* host.watch();
        yield* expectProfile(host, "수아 수정");
        expect(yield* host.read(retained.parent.id)).toEqual(retained.snapshot);
        expect(yield* retained.finish).toBe("removed");
        yield* Effect.sleep("200 millis");
        const child = yield* host.nativeChild(retained.parent, kind);
        yield* expectPrompt(host, child.id, updated.prompt);
        expect((yield* host.remote.sessions.get(child.id)).location.directory).toBe(
          sessionDirectory(fixture.personaDirectory, child.id),
        );
        expect(yield* host.read(retained.parent.id)).toEqual(retained.snapshot);
      }),
    )(),
);

test(
  "a native session admitted after the refresh inventory still receives that edit through the native event stream",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const retained = yield* beginRetainingParent(host);
      yield* retained.finish;
      yield* host.activeSession("persona1", "current@example.com");
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the indigo street sign.",
      };
      const gate = yield* beginCatalogEdit(host, fixture, updated);
      const child = yield* host.nativeChild(retained.parent);
      yield* host.ensure(child.id);
      expect((yield* host.read(child.id)).persona.prompt).toBe(retained.snapshot.persona.prompt);
      yield* gate.release;
      yield* expectProfile(host, "수아 수정");
      yield* expectPrompt(host, child.id, updated.prompt);
      expect(yield* host.read(retained.parent.id)).toEqual(retained.snapshot);
    }),
  ),
);

test(
  "startup adopts inherited native locations, updates them, and never changes an explicitly retained binding",
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
      const updated = { ...host.personas.get("persona1")!, prompt: "You like the river ferry." };
      yield* Effect.promise(() => fixture.store.update(updated));
      const next = yield* loadPersonas(fixture.catalogDirectory);
      yield* syncFolders(host.remote.client, fixture.personaDirectory, next);
      expect((yield* host.remote.sessions.get(child.id)).location.directory).toBe(
        sessionDirectory(fixture.personaDirectory, child.id),
      );
      yield* expectPrompt(host, child.id, updated.prompt);
      expect(yield* host.read(parent.id)).toEqual(original);
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
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You collect green sea glass.",
      };
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
      expect(yield* host.read(retained.parent.id)).toEqual(retained.snapshot);
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
      yield* syncFolders(host.remote.client, fixture.personaDirectory, updated);
      yield* expectPrompt(host, managed.id, "You draw the seaside market.");
      expect(yield* host.remote.sessions.get(unrelated.id)).toEqual(before);
    }),
  ),
);

test(
  "a native persona missing from the proposed catalog rejects the whole edit and later recovers",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const harin = yield* host.remote.createSession("harin");
      const original = yield* host.read(active.id);
      const saved = host.personas.get("harin")!;
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You grow lavender on the balcony.",
      };
      const next = yield* catalogWithoutHarin(fixture, updated);
      expect(
        (yield* syncFolders(host.remote.client, fixture.personaDirectory, next).pipe(Effect.flip))
          .message,
      ).toContain(`Managed session ${harin.id} has no catalog persona`);
      expect(yield* host.read(active.id)).toEqual(original);
      yield* host.watch();
      yield* Effect.sleep("200 millis");
      expect(yield* host.profileName()).toBe("수아");
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
        (yield* syncFolders(host.remote.client, fixture.personaDirectory, updated).pipe(
          Effect.flip,
        )).message,
      ).toContain(`Managed session ${id} has no catalog persona`);
      expect(yield* host.read(active.id)).toEqual(original);
      yield* host.remote.client.session.switchAgent({
        sessionID: id,
        agent: Agent.ID.make("persona1"),
      });
      yield* host.remote.sessions.wait(id);
      yield* syncFolders(host.remote.client, fixture.personaDirectory, updated);
      yield* expectPrompt(host, id, "This change requires a valid selected agent.");
    }),
  ),
);

test(
  "a closed native event connection reconnects and reconciles sessions created during the gap",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const retained = yield* beginRetainingParent(host);
      yield* retained.finish;
      const disconnected = yield* Deferred.make<void>();
      let connections = 0;
      host.transport.after = async (request, response) => {
        if (new URL(request.url).pathname !== "/api/event") return response;
        if (++connections !== 1) return response;
        const reader = response.body!.getReader();
        const first = await reader.read();
        await reader.cancel();
        await Effect.runPromise(Deferred.succeed(disconnected, undefined));
        const chunk = Schema.decodeUnknownSync(Schema.Uint8Array)(first.value);
        return new Response(new TextDecoder().decode(chunk), {
          status: response.status,
          headers: response.headers,
        });
      };
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You have the cobalt blue notebook.",
      };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* Deferred.await(disconnected).pipe(Effect.timeout("5 seconds"));
      yield* expectProfile(host, "수아 수정");
      const child = yield* host.nativeChild(retained.parent);
      yield* expectPrompt(host, child.id, updated.prompt);
      yield* Effect.promise(async () => {
        await expect.poll(() => connections, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
      });
      expect(yield* host.read(retained.parent.id)).toEqual(retained.snapshot);
    }),
  ),
);
