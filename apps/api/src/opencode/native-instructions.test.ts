import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import { expect, test } from "vitest";
import { messagingFixture, runMessagingTest } from "../../test/messaging.test-helper.ts";
import { scriptedPersona, standaloneTestHost } from "../../test/messaging-host.test-helper.ts";
import { localOpenCode } from "../../test/server.test-helper.ts";

test("context preserves the native persona and AGENTS.md updates while stripping OpenCode guidance", async () => {
  const { root, personaDirectory } = await messagingFixture("native-instructions-");
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const llm = yield* scriptedPersona();
        yield* llm.serve(() => TestLLM.text("reply", "answer"));
        const native = yield* standaloneTestHost(root, personaDirectory, llm);
        const session = yield* native.createSession("persona1");
        const remote = yield* localOpenCode(native, personaDirectory);
        const rules = join(session.location.directory, "AGENTS.md");
        yield* Effect.promise(() =>
          writeFile(rules, "Native ground rules: preserve the secret mango.\n"),
        );
        yield* remote.sessions.prompt({
          sessionID: session.id,
          text: "first turn",
        });
        yield* remote.sessions.wait(session.id);
        const first = (yield* llm.requests()).find((request) =>
          JSON.stringify(request.system).includes("You are Persona1."),
        )!;
        expect(JSON.stringify(first.system)).toContain("You are Persona1.");
        expect(JSON.stringify(first.system)).toContain("preserve the secret mango");
        expect(JSON.stringify(first)).not.toMatch(
          /Working directory:|Today's date:|# Code Mode|Skills provide specialized/,
        );
        const changed = yield* Deferred.make<void>();
        const unsubscribe = yield* native.events.listen((event) =>
          event.type === "instruction-discovery.updated" &&
          event.location?.directory === session.location.directory
            ? Deferred.succeed(changed, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        yield* Effect.promise(() =>
          writeFile(rules, "Native ground rules: preserve the secret pineapple.\n"),
        );
        yield* Deferred.await(changed).pipe(Effect.timeout("5 seconds"));
        yield* unsubscribe;
        yield* remote.sessions.prompt({
          sessionID: session.id,
          text: "second turn",
        });
        yield* remote.sessions.wait(session.id);
        const last = (yield* llm.requests()).at(-1)!;
        expect(JSON.stringify(last)).toContain("secret pineapple");
        expect(JSON.stringify(last.messages)).toMatch(/instructions (?:from|changed)/);
        expect(JSON.stringify(last.system)).toContain("You are Persona1.");
        expect(JSON.stringify(last)).not.toMatch(
          /Working directory:|Today's date:|# Code Mode|Skills provide specialized/,
        );
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
