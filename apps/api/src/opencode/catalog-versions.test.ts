import { Effect } from "effect";
import { expect, test } from "vitest";
import { serializePersona } from "@ren-ai/personas";
import { authoredDefinition, catalogTest, expectPrompt } from "./catalog-sync.test-helper.ts";

test(
  "native sessions use the latest saved document and a rollback release without losing conversation state",
  catalogTest((host, fixture) =>
    Effect.gen(function* () {
      const active = yield* host.metParent();
      const first = yield* Effect.promise(async () =>
        fixture.store.update({ ...(await fixture.store.get("persona1")), published: false }),
      );
      const evolving = yield* host.read(active.id);
      const second = yield* Effect.promise(() =>
        fixture.store.update(
          authoredDefinition({
            ...first,
            prompt: "You prefer saffron tea. This is the latest definition.",
          }),
        ),
      );
      yield* host.refresh;
      yield* expectPrompt(host, active.id, second.prompt);
      expect((yield* host.read(active.id)).persona.version).toBe(second.version);
      yield* host.remote.sessions.prompt({ sessionID: active.id, text: "after version two" });
      yield* host.remote.sessions.wait(active.id);
      expect(JSON.stringify((yield* host.llm.requests()).at(-1)!.system)).toContain("saffron tea");
      const restored = yield* Effect.promise(() =>
        fixture.store.save(
          first,
          { state: "", memory: "" },
          { persona: serializePersona(second), restoredFrom: 1 },
        ),
      );
      expect(restored.version).toBe(3);
      yield* host.refresh;
      yield* expectPrompt(host, active.id, first.prompt);
      const current = yield* host.read(active.id);
      expect(current.persona.version).toBe(3);
      expect(current.documents).toEqual(evolving.documents);
      expect(current.runtime).toEqual(evolving.runtime);
      yield* host.remote.sessions.prompt({
        sessionID: active.id,
        text: "after restoring version one",
      });
      yield* host.remote.sessions.wait(active.id);
      expect(JSON.stringify((yield* host.llm.requests()).at(-1)!.system)).toContain(
        "You are Persona1.",
      );
      const history = JSON.stringify(
        yield* host.remote.sessions.messages({ sessionID: active.id }),
      );
      expect(history).toContain("Remember our first conversation.");
      expect(history).toContain("after version two");
    }),
  ),
);
