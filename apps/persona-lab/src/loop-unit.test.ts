import { expect, it } from "vitest";
import type { Model } from "@ren-ai/persona-engine";
import type { Judge } from "./judge.ts";
import { admit, begin, decide } from "./loop.ts";
import { personas } from "./personas.ts";

const user = { id: "u1", kind: "user", text: "안녕" } as const;
const start = () => begin(personas["harin"]!, "harin", 1_000);
const send =
  (unitEnded: boolean): Judge =>
  async () => ({
    action: "send_now",
    probabilities: {},
    shifts: {},
    meaningfulAbsence: false,
    unitEnded,
    stage: "stranger",
  });
const model: Model = async () => ({ reply: "안녕", changes: [] });
const admitted = admit(start(), user);

it("closes a conversation unit after a reply that Jev ended, and keeps it open otherwise", async () => {
  const ended = await decide(admitted, "input", 2_000, "d1", send(true), model);
  expect(ended.character.session.events).toHaveLength(2);
  expect(ended.character.session.unitStart).toBe(2);
  expect(ended.character.entries.at(-1)).toEqual({
    type: "unit",
    id: "d1:reply",
    reason: "대화 단위 d1:reply",
  });
  expect(admit(ended.character, { id: "u2", kind: "user", text: "또" }).session.unitStart).toBe(2);
  const open = await decide(admitted, "input", 2_000, "d2", send(false), model);
  expect(open.character.session.unitStart).toBe(0);
  expect(open.character.entries.at(-1)?.type).toBe("reply");
});
