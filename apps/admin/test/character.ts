import { modelReply } from "./sub-portraits.ts";
import { sheet as sampleSheet } from "./sheet.ts";
export const sheet = sampleSheet;
const scores = { mood: 55, energy: 60, stress: 35, connection: 55, solitude: 60, affection: 18 };
export const characterResponse = (value: object = sheet, conversion = false) =>
  modelReply(
    JSON.stringify(
      "issues" in value
        ? { additions: [], ...value }
        : {
            persona: {
              ...(!conversion && { languageBackground: { primary: "ko", native: ["ko"] } }),
              ...value,
            },
            publicProfile: "천천히 알아가는 쪽이 편해요.",
            ...(!conversion && {
              state: { ...scores, languageProficiency: { ko: "fluent" } },
              memory: "# 현재 생활\n\n- 사진전을 준비 중이다.\n",
            }),
          },
    ),
  );
export const acceptedReview = () => characterResponse({ issues: [] });
