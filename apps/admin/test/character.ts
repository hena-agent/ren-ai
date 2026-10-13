import { modelReply } from "./sub-portraits.ts";
import { CharacterSheet, renderCharacterSheet } from "@ren-ai/personas";
import { Schema } from "effect";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { sheet as sampleSheet } from "./sheet.ts";
export const sheet = sampleSheet;
const scores = { mood: 55, energy: 60, stress: 35, connection: 55, solitude: 60 };
export const characterResponse = (value: object = sheet, conversion = false) =>
  modelReply(
    Schema.is(CharacterSheet)(value)
      ? conversion
        ? withPublicProfile(renderCharacterSheet(value), "천천히 알아가는 쪽이 편해요.")
        : JSON.stringify({
            persona: withPublicProfile(renderCharacterSheet(value), "천천히 알아가는 쪽이 편해요."),
            state: scores,
            memory: "# 현재 생활\n\n- 사진전을 준비 중이다.\n",
          })
      : JSON.stringify("issues" in value ? { additions: [], ...value } : value),
  );
export const acceptedReview = () => characterResponse({ issues: [] });
