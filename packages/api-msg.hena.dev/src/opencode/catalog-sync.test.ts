import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { loadGroundRules } from "@ren-ai/plugin-session-folder/files";
import { expect, test } from "vitest";
import { retainedSessions } from "../conversations/retained.ts";
import { syncFolders } from "./catalog-sync.ts";
import {
  catalogTest,
  expectProfile,
  expectPrompt,
  catalogWithoutHarin,
} from "./catalog-sync.test-helper.ts";
import { unrestricted } from "../../test/host.test-helper.ts";

test(
  "an edit between startup sync and watching reaches active native sessions and the public catalog, but not retained folders",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const retained = yield* host.remote.createSession("persona1");
      const retention = yield* retainedSessions(host.remote);
      yield* retention.retainRemoved(retained.id, "retained@example.com");
      const old = yield* host.read(retained.id);
      yield* host.write(active.id, { ...old, rules: "Rules from before the deployment." });
      yield* syncFolders(host.remote.client, fixture.personaDirectory, host.personas);
      const rules = yield* Effect.promise(loadGroundRules);
      expect((yield* host.read(active.id)).rules).toBe(rules);
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the turquoise umbrella.",
      };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* expectPrompt(host, active.id, updated.prompt);
      yield* expectProfile(host, "수아 수정");
      expect(yield* host.read(retained.id)).toEqual(old);
      yield* Effect.promise(async () => {
        await expect
          .poll(
            async () =>
              (
                await Effect.runPromise(
                  host.remote.client.agent.list({ location: active.location }),
                )
              ).data.find((agent) => agent.id === "persona1")?.system,
          )
          .toBe(updated.prompt);
      });
      yield* host.remote.sessions
        .prompt({ sessionID: active.id, text: "Hi" })
        .pipe(Effect.timeout("5 seconds"));
      yield* host.remote.sessions.wait(active.id).pipe(Effect.timeout("5 seconds"));
      expect(JSON.stringify(yield* host.llm.requests())).toContain("turquoise umbrella");
      const live = { ...updated, prompt: "You collect postcards from Busan." };
      yield* host.write(active.id, {
        ...(yield* host.read(active.id)),
        rules: "Outdated rules awaiting the next edit.",
      });
      yield* Effect.promise(() => fixture.store.update(live));
      yield* expectPrompt(host, active.id, live.prompt);
      expect(yield* host.read(retained.id)).toEqual(old);
      expect((yield* host.read(active.id)).rules).toBe(rules);
    }),
  ),
);

test(
  "a malformed live catalog preserves the public catalog and session files, then recovers without restarting",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const old = yield* host.read(active.id);
      const filename = join(fixture.catalogDirectory, "persona1.md");
      const source = yield* Effect.promise(() => readFile(filename, "utf8"));
      yield* Effect.promise(() =>
        fixture.store.update({ ...host.personas.get("persona1")!, name: "준비된 수아" }),
      );
      yield* host.watch();
      yield* expectProfile(host, "준비된 수아");
      yield* Effect.promise(() => writeFile(filename, "broken frontmatter"));
      yield* Effect.sleep("1100 millis");
      expect(yield* host.read(active.id)).toEqual(old);
      expect(yield* host.profileName()).toBe("준비된 수아");
      yield* Effect.promise(() =>
        writeFile(filename, source.replace("You are Persona1.", "You remember the yellow scarf.")),
      );
      yield* expectPrompt(host, active.id, "You remember the yellow scarf.\n");
    }),
  ),
);

test(
  "deleting an active persona rejects the entire update before another active folder is changed",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const harin = yield* host.activeSession("harin", "harin@example.com");
      const old = yield* host.read(active.id);
      const savedHarin = host.personas.get("harin")!;
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "A change that must be held back.",
      };
      const next = yield* catalogWithoutHarin(fixture, updated);
      expect(
        (yield* syncFolders(host.remote.client, fixture.personaDirectory, next).pipe(Effect.flip))
          .message,
      ).toContain("Active persona harin is missing");
      expect(yield* host.read(active.id)).toEqual(old);
      yield* host.watch();
      yield* Effect.sleep("1100 millis");
      expect((yield* host.api.list()).map((persona) => persona.name)).toEqual(["하린", "수아"]);
      expect(yield* host.read(harin.id)).toMatchObject({ persona: { prompt: "You are Harin." } });
      yield* Effect.promise(() => fixture.store.create(savedHarin));
      yield* expectPrompt(host, active.id, updated.prompt);
      yield* expectProfile(host, "수아 수정");
    }),
  ),
);

test(
  "a failed folder RPC write keeps the public catalog unchanged and retries without another edit",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const filename = join(active.location.directory, "AGENTS.md");
      const rules = yield* Effect.promise(() => readFile(filename, "utf8"));
      yield* Effect.promise(async () => {
        await rm(filename);
        await mkdir(filename);
      });
      const updated = {
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You like evening walks.",
      };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.watch();
      yield* Effect.sleep("1100 millis");
      expect(yield* host.profileName()).toBe("수아");
      yield* Effect.promise(async () => {
        await rm(filename, { recursive: true });
        await writeFile(filename, rules);
      });
      yield* expectPrompt(host, active.id, updated.prompt);
      yield* expectProfile(host, "수아 수정");
    }),
  ),
);

test(
  "a missing watch directory is retried and a later directory replacement is also watched",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const offline = `${fixture.catalogDirectory}-offline`;
      yield* Effect.promise(() => rename(fixture.catalogDirectory, offline));
      yield* host.watch();
      yield* Effect.sleep("1100 millis");
      expect(yield* host.profileName()).toBe("수아");
      yield* Effect.promise(async () => {
        await rename(offline, fixture.catalogDirectory);
        await fixture.store.update({ ...host.personas.get("persona1")!, name: "돌아온 수아" });
      });
      yield* expectProfile(host, "돌아온 수아");
      const updated = { ...host.personas.get("persona1")!, prompt: "You like rainy afternoons." };
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* expectPrompt(host, active.id, updated.prompt);
      yield* Effect.promise(() => rename(fixture.catalogDirectory, offline));
      yield* Effect.sleep("1100 millis");
      expect(yield* host.profileName()).toBe("돌아온 수아");
      yield* Effect.promise(async () => {
        await rename(offline, fixture.catalogDirectory);
        await fixture.store.update({ ...updated, name: "다시 만난 수아" });
      });
      yield* expectProfile(host, "다시 만난 수아");
    }),
  ),
);

test(
  "startup skips missing sessions but rejects legacy root sessions without rewriting valid folders",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const missing = yield* host.activeSession("persona1", "missing@example.com");
      yield* host.remote.client.session.remove({ sessionID: missing.id });
      yield* syncFolders(host.remote.client, fixture.personaDirectory, host.personas);
      const active = yield* host.activeSession();
      const old = yield* host.read(active.id);
      const legacy = yield* host.remote.client.session.create(
        unrestricted(fixture.personaDirectory),
      );
      yield* host.directory.create({
        handle: "legacy@example.com",
        locale: "ko",
        consentVersion: "v1",
        consentLanguage: "ko",
        personaID: "persona1",
        sessionID: legacy.id,
      });
      const updated = new Map(host.personas);
      updated.set("persona1", {
        ...updated.get("persona1")!,
        prompt: "This update must wait for migration.",
      });
      expect(
        (yield* syncFolders(host.remote.client, fixture.personaDirectory, updated).pipe(
          Effect.flip,
        )).message,
      ).toContain("Migrate existing sessions");
      expect(yield* host.read(active.id)).toEqual(old);
    }),
  ),
);
