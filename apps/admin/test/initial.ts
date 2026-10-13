import { serializeInitialState } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { renderCharacterSheet } from "@ren-ai/personas";
import { sheet } from "./character.ts";
import { fixture, generator, legacy } from "./fixtures.ts";
import type { ProfileGenerator } from "../src/generation.ts";

export const scores = {
  mood: 55,
  energy: 60,
  stress: 35,
  connection: 55,
  solitude: 60,
  affection: 18,
};
export const initialDocs = {
  state: serializeInitialState({
    ...scores,
    traits: { "도움 요청 회피": { strength: 80, active: true, persistence: "lasting" } },
  }),
  memory: "# 현재 생활\n\n- 사진전을 준비 중이다.\n",
};
export const initialPersona = {
  ...legacy,
  id: "harin",
  name: sheet.name,
  gender: sheet.gender,
  description: withPublicProfile(renderCharacterSheet(sheet), "천천히 알아가요."),
  published: true,
};
export async function initialFixture(
  model: ProfileGenerator = {
    ...generator,
    state: async () => initialDocs.state,
    memory: async () => initialDocs.memory,
  },
) {
  const setup = await fixture(model);
  await setup.store.create(initialPersona);
  return setup;
}
