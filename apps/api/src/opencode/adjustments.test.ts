import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { expect, test } from "vitest";
import {
  personaAdjustments,
  readAdjustments,
  writeAdjustments,
  isAdjustmentTool,
  adjustmentTool,
} from "@ren-ai/plugin-session-folder/adjustments";
import { emptyAdjustments } from "../../../../packages/plugins/session-folder/src/adjustment-model.ts";
import { writeSessionBinding } from "@ren-ai/plugin-session-folder/bindings";
import { withPersona } from "../../test/memory.test-helper.ts";

const day = 86_400_000;
const start = 1000;
const reviewID = (context: string) => /<adjustment-review reviewID="([^"]+)"/.exec(context)![1]!;
const ready = async (root: string) => {
  const a = personaAdjustments(root, "sesa");
  for (let index = 0; index < 20; index++) await a.context(`message-${index}`, start);
  return { a, id: reviewID(await a.context("message-19", start + day)) };
};

test("reviews require both elapsed time and fresh input; repeated model steps and idle reads are free of writes", () =>
  withPersona(async (root) => {
    const a = personaAdjustments(root, "sesa");
    expect(await a.context()).not.toContain("<adjustment-review");
    expect(await readAdjustments(root)).toBeUndefined();
    await a.context("first", start);
    const before = await readFile(join(root, ".memory", "adjustments.json"), "utf8");
    await a.context("first", start + day);
    expect(await readFile(join(root, ".memory", "adjustments.json"), "utf8")).toBe(before);
    for (let index = 0; index < 18; index++) await a.context(`new-${index}`, start + day);
    expect(await a.context("new-17", start + day)).not.toContain("<adjustment-review");
    const context = await a.context("twentieth", start + day);
    expect(context).toContain("<adjustment-review");
    expect(context).toContain("Silence alone proves nothing");
    expect(context).toContain("Preserve your personality");
    expect(context).toContain("THIS Conversation");
    expect(await a.context()).not.toContain("<adjustment-review");
    const id = reviewID(context);
    const input = {
      reviewID: id,
      markdown: "내 이야기도 조금 꺼낸다.",
      reason: "질문에만 치우쳤다.",
    };
    expect(await a.run(input, "review", start + day)).toBe("Adjustments updated");
    expect(await a.run(input, "review")).toBe("Adjustments updated");
    await expect(a.run({ ...input, markdown: "changed" }, "review")).rejects.toThrow(
      "input changed",
    );
    const saved = (await readAdjustments(root))!;
    expect(saved.state.history).toEqual([
      { at: start + day, before: "", after: input.markdown, reason: input.reason },
    ]);
    expect(await readFile(join(root, "ADJUSTMENTS.md"), "utf8")).toBe(input.markdown);
    const b = personaAdjustments(root, "sesb");
    expect(await b.context("other", start + day)).toContain(input.markdown);
    expect(await b.context("other", start + day)).not.toContain(input.reason);
    expect(await a.context("later", start + 2 * day)).not.toContain("<adjustment-review");
  }));

test("one Persona review lease coordinates concurrent Conversations, survives replacement and preserves later inputs", () =>
  withPersona(async (root) => {
    const { a, id } = await ready(root);
    const b = personaAdjustments(root, "sesb");
    expect(await b.context("other-input", start + day)).not.toContain("<adjustment-review");
    await expect(
      b.run({ reviewID: id, markdown: "wrong writer", reason: "wrong" }, "other", start + day),
    ).rejects.toThrow("expired or changed");
    expect(
      reviewID(await personaAdjustments(root, "sesa").context("message-19", start + day)),
    ).toBe(id);
    await a.run(
      { reviewID: id, markdown: null, reason: "근거가 부족해 유지한다." },
      "keep",
      start + day,
    );
    const saved = (await readAdjustments(root))!;
    expect(saved.markdown).toBe("");
    expect(saved.state.observed - saved.state.reviewed).toBe(1);
    expect(saved.state.history[0]!.before).toBe(saved.state.history[0]!.after);
    for (let index = 0; index < 19; index++) await b.context(`next-${index}`, start + day);
    expect(await b.context("next-18", start + day)).not.toContain("<adjustment-review");
    const next = reviewID(await b.context("next-18", start + 2 * day));
    expect(
      await b.run({ reviewID: next, markdown: "", reason: "유지" }, "same", start + 2 * day),
    ).toBe("Adjustments unchanged");
  }));

test("expired reviews can be reclaimed and stale document edits cannot be overwritten", () =>
  withPersona(async (root) => {
    const { a, id } = await ready(root);
    const input = { reviewID: id, markdown: "old proposal", reason: "old" };
    await expect(a.run(input, "expired", start + day + 600_000)).rejects.toThrow(
      "expired or changed",
    );
    const b = personaAdjustments(root, "sesb");
    const replacement = reviewID(await b.context("new", start + day + 600_000));
    expect(replacement).not.toBe(id);
    await expect(a.run(input, "old-owner", start + day + 600_000)).rejects.toThrow(
      "expired or changed",
    );
    await writeFile(join(root, "ADJUSTMENTS.md"), "Operator adjustment");
    await expect(
      b.run({ ...input, reviewID: replacement }, "stale", start + day + 600_001),
    ).rejects.toThrow("expired or changed");
    expect((await readAdjustments(root))!.markdown).toBe("Operator adjustment");
    const newest = reviewID(await b.context("new", start + day + 1_200_000));
    await b.run(
      { ...input, reviewID: newest, markdown: "New adjustment" },
      "fresh",
      start + day + 1_200_000,
    );
  }));

test("simultaneous eligible Conversations claim only one persisted review", () =>
  withPersona(async (root) => {
    await writeAdjustments(root, {
      ...emptyAdjustments(),
      state: { ...emptyAdjustments().state, reviewedAt: start, observed: 20 },
    });
    const contexts = await Promise.all([
      personaAdjustments(root, "sesa").context("a", start + day),
      personaAdjustments(root, "sesb").context("b", start + day),
    ]);
    expect(contexts.filter((context) => context.includes("<adjustment-review"))).toHaveLength(1);
    expect((await readAdjustments(root))!.state.observed).toBe(22);
  }));

test("read-only replay and ended Conversations cannot schedule reviews or modify adjustments", () =>
  withPersona(async (root) => {
    const { a, id } = await ready(root);
    await writeSessionBinding(root, root, "sesa", {
      personaID: "persona1",
      conversationKey: "a",
      writable: false,
    });
    const before = await readAdjustments(root);
    expect(await a.context("replay", start + 2 * day)).not.toContain("<adjustment-review");
    expect(await readAdjustments(root)).toEqual(before);
    await expect(a.run({ reviewID: id, markdown: "no", reason: "no" }, "ended")).rejects.toThrow(
      "read-only",
    );
  }));

test("a deleted optional document stays absent through no-change reviews while history and scheduling survive", () =>
  withPersona(async (root) => {
    const { a, id } = await ready(root);
    await expect(readFile(join(root, "ADJUSTMENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await a.run(
      { reviewID: id, markdown: "Share a little more.", reason: "Balance participation." },
      "first-review",
      start + day,
    );
    const history = (await readAdjustments(root))!.state.history;
    await rm(join(root, "ADJUSTMENTS.md"));
    expect(await a.context("message-19", start + day)).not.toContain("Share a little more.");
    expect((await readAdjustments(root))!.state.history).toEqual(history);
    for (let index = 0; index < 20; index++) await a.context(`later-${index}`, start + 2 * day);
    const keep = reviewID(await a.context("later-19", start + 2 * day));
    await a.run(
      { reviewID: keep, markdown: null, reason: "No supported correction." },
      "keep-missing",
      start + 2 * day,
    );
    expect((await readAdjustments(root))!.state.history).toHaveLength(2);
    await expect(readFile(join(root, "ADJUSTMENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (let index = 0; index < 20; index++) await a.context(`fresh-${index}`, start + 3 * day);
    const change = reviewID(await a.context("fresh-19", start + 3 * day));
    await a.run(
      {
        reviewID: change,
        markdown: "Follow the interesting detail.",
        reason: "Keep exchanges concrete.",
      },
      "recreate",
      start + 3 * day,
    );
    expect(await readFile(join(root, "ADJUSTMENTS.md"), "utf8")).toBe(
      "Follow the interesting detail.",
    );
    expect((await readAdjustments(root))!.state.history).toHaveLength(3);
  }));

test("invalid tools, inputs and malformed state fail closed; optional documents and interrupted commits are recovered", () =>
  withPersona(async (root) => {
    const a = personaAdjustments(root, "sesa");
    await expect(
      a.run({ reviewID: "none", markdown: null, reason: "none" }, "early"),
    ).rejects.toThrow("expired or changed");
    for (const input of [
      null,
      { reviewID: "x", markdown: "x".repeat(6001), reason: "x" },
      { reviewID: "x", markdown: "x", reason: "x", path: "AGENTS.md" },
    ])
      await expect(a.run(input, "invalid")).rejects.toThrow("Invalid adjustment tool input");
    expect(isAdjustmentTool(undefined)).toBe(false);
    expect(isAdjustmentTool({ description: "fake", input: {} })).toBe(false);
    expect(isAdjustmentTool({ description: adjustmentTool.description, input: {} })).toBe(false);
    expect(
      isAdjustmentTool({
        description: adjustmentTool.description,
        input: Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(adjustmentTool.input))[
          "~standard"
        ].jsonSchema.input({ target: "draft-2020-12" }),
      }),
    ).toBe(true);
    await writeFile(join(root, "ADJUSTMENTS.md"), "Operator-authored adjustment");
    expect(await readAdjustments(root)).toEqual({
      ...emptyAdjustments(),
      markdown: "Operator-authored adjustment",
    });
    await writeAdjustments(root, emptyAdjustments());
    await expect(readFile(join(root, "ADJUSTMENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const changed = { ...emptyAdjustments(), markdown: "Recovered adjustment" };
    await writeFile(
      join(root, ".memory", "pending.json"),
      JSON.stringify([
        { name: "ADJUSTMENTS.md", text: changed.markdown },
        { name: ".memory/adjustments.json", text: JSON.stringify(changed.state) },
      ]),
    );
    expect(await readAdjustments(root)).toEqual(changed);
    await rm(join(root, "ADJUSTMENTS.md"));
    expect(await readAdjustments(root)).toEqual(emptyAdjustments());
    await writeFile(join(root, ".memory", "adjustments.json"), "invalid state");
    await expect(readAdjustments(root)).rejects.toThrow("Invalid Persona adjustment files");
  }));
