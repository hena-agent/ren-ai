import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { retainedSessions } from "../conversations/retained.ts";
import { syncFolders } from "./catalog-sync.ts";
import {
  catalogTest,
  authoredDefinition,
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
      yield* syncFolders(
        host.remote.client,
        fixture.personaDirectory,
        host.personas,
        fixture.groundRules,
      );
      const rules = fixture.groundRules;
      expect((yield* host.read(active.id)).rules).toBe(rules);
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You remember the turquoise umbrella.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.refresh;
      yield* expectPrompt(host, active.id, updated.prompt);
      yield* expectProfile(host, "수아 수정");
      expect(yield* host.read(retained.id)).toEqual(old);
      // Native location/config initialization is asynchronous even after the RPC completes.
      yield* Effect.promise(async () => {
        await expect
          .poll(
            async () =>
              (
                await Effect.runPromise(
                  host.remote.client.agent.list({ location: active.location }),
                )
              ).data.find((agent) => agent.id === "persona1")?.system,
            { timeout: 5_000 },
          )
          .toBe(updated.prompt);
      });
      yield* host.remote.sessions
        .prompt({ sessionID: active.id, text: "Hi" })
        .pipe(Effect.timeout("5 seconds"));
      yield* host.remote.sessions.wait(active.id).pipe(Effect.timeout("5 seconds"));
      expect(JSON.stringify(yield* host.llm.requests())).toContain("turquoise umbrella");
      const live = authoredDefinition({ ...updated, prompt: "You collect postcards from Busan." });
      yield* host.write(active.id, {
        ...(yield* host.read(active.id)),
        rules: "Outdated rules awaiting the next edit.",
      });
      yield* Effect.promise(() => fixture.store.update(live));
      yield* host.refresh;
      yield* expectPrompt(host, active.id, live.prompt);
      expect(yield* host.read(retained.id)).toEqual(old);
      expect((yield* host.read(active.id)).rules).toBe(rules);
    }),
  ),
);

test(
  "catalog revisions preserve live state when a persona description is unchanged",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const live = {
        ...host.personas.get("persona1")!,
        memory: "Memory written during this session.",
      };
      host.personas.set("persona1", live);
      const updated = authoredDefinition({ ...live, name: "이름만 수정" });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.refresh;
      yield* expectProfile(host, "이름만 수정");
      expect(host.personas.get("persona1")?.memory).toBe(live.memory);
      expect((yield* host.read(active.id)).persona.memory).toBe(live.memory);
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
      yield* host.refresh;
      yield* expectProfile(host, "준비된 수아");
      yield* Effect.promise(() => writeFile(filename, "broken frontmatter"));
      yield* host.refresh;
      expect(yield* host.read(active.id)).toEqual(old);
      expect(yield* host.profileName()).toBe("준비된 수아");
      yield* Effect.promise(() =>
        writeFile(filename, source.replace("You are Persona1.", "You remember the yellow scarf.")),
      );
      yield* host.refresh;
      yield* expectPrompt(
        host,
        active.id,
        "You remember the yellow scarf.\n\n## 공개 프로필\n\n24살 대학생\n",
      );
    }),
  ),
);

test(
  "an absent Catalog persona preserves her session snapshot while valid Catalog changes are synchronized",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.activeSession();
      const harin = yield* host.activeSession("harin", "harin@example.com");
      const old = yield* host.read(harin.id);
      const savedHarin = host.personas.get("harin")!;
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "A valid Catalog update.",
      });
      const next = yield* catalogWithoutHarin(fixture, updated);
      yield* syncFolders(host.remote.client, fixture.personaDirectory, next, fixture.groundRules);
      expect(yield* host.read(active.id)).toMatchObject({ persona: { prompt: updated.prompt } });
      expect(yield* host.read(harin.id)).toEqual(old);
      expect(next.get("harin")?.published).toBe(false);
      yield* host.refresh;
      expect(
        [...host.personas.values()].filter((persona) => persona.published).map((p) => p.name),
      ).toEqual(["수아 수정"]);
      expect(yield* host.read(harin.id)).toMatchObject({
        persona: { prompt: "You are Harin.\n\n## 공개 프로필\n\n29살 서울 사진가" },
      });
      yield* Effect.promise(() => fixture.store.create(savedHarin));
      yield* host.refresh;
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
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        name: "수아 수정",
        prompt: "You like evening walks.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.refresh;
      expect(yield* host.profileName()).toBe("수아");
      yield* Effect.promise(async () => {
        await rm(filename, { recursive: true });
        await writeFile(filename, rules);
      });
      yield* host.refresh;
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
      yield* host.refresh;
      expect(yield* host.profileName()).toBe("수아");
      yield* Effect.promise(async () => {
        await rename(offline, fixture.catalogDirectory);
        await fixture.store.update({ ...host.personas.get("persona1")!, name: "돌아온 수아" });
      });
      yield* host.refresh;
      yield* expectProfile(host, "돌아온 수아");
      const updated = authoredDefinition({
        ...host.personas.get("persona1")!,
        prompt: "You like rainy afternoons.",
      });
      yield* Effect.promise(() => fixture.store.update(updated));
      yield* host.refresh;
      yield* expectPrompt(host, active.id, updated.prompt);
      yield* Effect.promise(() => rename(fixture.catalogDirectory, offline));
      yield* host.refresh;
      expect(yield* host.profileName()).toBe("돌아온 수아");
      yield* Effect.promise(async () => {
        await rename(offline, fixture.catalogDirectory);
        await fixture.store.update({ ...updated, name: "다시 만난 수아" });
      });
      yield* host.refresh;
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
      yield* syncFolders(
        host.remote.client,
        fixture.personaDirectory,
        host.personas,
        fixture.groundRules,
      );
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
        (yield* syncFolders(
          host.remote.client,
          fixture.personaDirectory,
          updated,
          fixture.groundRules,
        ).pipe(Effect.flip)).message,
      ).toContain("Migrate existing sessions");
      expect(yield* host.read(active.id)).toEqual(old);
    }),
  ),
);
