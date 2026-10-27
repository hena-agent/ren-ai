import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { TestLLM } from "@opencode/ai/testing";
import type { SessionContext } from "@opencode/plugin/effect/session";
import { expect, test } from "vitest";
import {
  appendAdjustmentInstructions,
  writeAdjustments,
} from "@ren-ai/plugin-session-folder/adjustments";
import { emptyAdjustments } from "../../../../packages/plugins/session-folder/src/adjustment-model.ts";
import { folderFiles } from "@ren-ai/plugin-session-folder/files";
import { withRemoteHost } from "../../test/remote-host.test-helper.ts";

test.each([
  "",
  "\n\nInstructions from: /other/notes.md\nOther instructions.",
  "\n\nToday's date: Tue Oct 27 2026\n\nHere is some useful information about the environment you are running in:\n<env>local</env>",
])(
  "the plugin inserts adjustments immediately after the native Ground rules, preserving subsequent sources (%s)",
  (suffix) => {
    const persona = { type: "text" as const, text: "Native Persona identity." };
    const base = "Instructions from: /persona/AGENTS.md\nFixed Ground rules.";
    const system: SessionContext["system"] = [persona, { type: "text", text: base + suffix }];
    appendAdjustmentInstructions(system, "/persona", { markdown: "My correction.", review: "" });
    expect(system).toEqual([
      persona,
      {
        type: "text",
        text: `${base}\n\nInstructions from: /persona/ADJUSTMENTS.md\nMy correction.${suffix}`,
      },
    ]);
    expect(system[0]).toBe(persona);
    appendAdjustmentInstructions(system, "/persona", {
      markdown: "Updated correction.",
      review: "",
    });
    expect(system.map((part) => part.text).join("\n")).not.toContain("My correction.");
    expect(
      system
        .map((part) => part.text)
        .join("\n")
        .split("Updated correction."),
    ).toHaveLength(2);
    appendAdjustmentInstructions(system, "/persona", { markdown: "", review: "" });
    expect(system).toEqual([persona, { type: "text", text: base + suffix }]);
  },
);

test("empty Ground rules still allow direct adjustment injection after the native Persona identity", () => {
  const system: SessionContext["system"] = [{ type: "text", text: "Native Persona." }];
  const review = '<adjustment-review reviewID="test">Review internally.</adjustment-review>';
  appendAdjustmentInstructions(system, "/persona", {
    markdown: "Current correction.",
    review,
  });
  expect(system.map((part) => part.text)).toEqual([
    "Native Persona.",
    "Instructions from: /persona/ADJUSTMENTS.md\nCurrent correction.",
    review,
  ]);
  appendAdjustmentInstructions(system, "/persona", { markdown: "Current correction.", review });
  expect(system).toHaveLength(3);
  appendAdjustmentInstructions(system, "/persona", { markdown: "", review: "" });
  expect(system).toEqual([{ type: "text", text: "Native Persona." }]);
});

test.each(["", " \n\t"])(
  "missing or blank adjustments add no placeholder or file-reading instructions (%s)",
  (markdown) => {
    const original = {
      type: "text" as const,
      text: "Instructions from: /persona/AGENTS.md\nGround rules.",
    };
    const system: SessionContext["system"] = [original];
    appendAdjustmentInstructions(system, "/persona", { markdown, review: "" });
    expect(system).toEqual([original]);
    expect(system[0]).toBe(original);
  },
);

test("real OC appends the latest corrections directly to Ground rules in primary and compaction requests", () =>
  withRemoteHost((remote, root, { llm }) =>
    Effect.gen(function* () {
      const session = yield* remote.createSession("persona1");
      const files = folderFiles(root);
      const original = yield* Effect.promise(() => files.read(session.id));
      const groundRules = "FIXED_GROUND_RULES_TOKEN";
      yield* Effect.promise(() => files.write(session.id, { ...original, rules: groundRules }));
      const replace = (markdown: string) =>
        Effect.promise(() =>
          writeAdjustments(session.location.directory, {
            ...emptyAdjustments(),
            markdown,
          }),
        );
      let phase = "first";
      let compactions = 0;
      yield* llm.serve((request) => {
        const compacting = JSON.stringify(request.messages).includes("Write her Memory");
        if (!compacting && !request.tools.some((tool) => tool.name === "review_adjustments"))
          return TestLLM.text("Persona1", "title");
        const system = request.system.map((part) => part.text).join("\n\n");
        expect(system).toContain("You are Persona1.");
        expect(system).toContain(groundRules);
        expect(system).not.toContain("<persona-adjustments");
        if (phase === "first" || phase === "second") {
          const correction =
            phase === "first" ? "FIRST_CORRECTION_TOKEN" : "SECOND_CORRECTION_TOKEN";
          const combined = `${groundRules}\n\nInstructions from: ${join(session.location.directory, "ADJUSTMENTS.md")}\n${correction}`;
          expect(system).toContain(combined);
          expect(system.split(correction)).toHaveLength(2);
          if (phase === "second") expect(system).not.toContain("FIRST_CORRECTION_TOKEN");
          if (!compacting)
            expect(system.indexOf("<current-state")).toBeGreaterThan(system.indexOf(correction));
        } else {
          expect(system).not.toContain("ADJUSTMENTS.md");
          expect(system).not.toContain("SECOND_CORRECTION_TOKEN");
        }
        if (compacting) {
          compactions++;
          expect(request.tools).toHaveLength(0);
          return TestLLM.text("## Important Context\nWe talked about books.", "checkpoint");
        }
        return phase === "first"
          ? TestLLM.textWithUsage("그 책 나도 궁금해.", "answer", 80_000)
          : TestLLM.text("계속 이야기하자.", "answer");
      });
      yield* replace("FIRST_CORRECTION_TOKEN");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "책 이야기하자." });
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      phase = "second";
      yield* replace("SECOND_CORRECTION_TOKEN");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "어떤 부분이 궁금해?" });
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      expect(compactions).toBe(1);
      phase = "missing";
      yield* Effect.promise(() => rm(join(session.location.directory, "ADJUSTMENTS.md")));
      yield* remote.sessions.prompt({ sessionID: session.id, text: "다른 얘기도 해볼까?" });
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      phase = "blank";
      yield* replace(" \n");
      yield* remote.sessions.prompt({ sessionID: session.id, text: "응." });
      yield* remote.sessions.wait(session.id);
      expect((yield* remote.sessions.get(session.id)).outcome).toBe("succeeded");
      expect((yield* Effect.promise(() => files.read(session.id))).rules).toBe(groundRules);
    }),
  ));
