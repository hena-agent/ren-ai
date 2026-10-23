import { selectSeeds } from "../src/seed-selection.ts";
import { authorization } from "./fixtures.ts";
import { sheet } from "./character.ts";
import { modelReply } from "./sub-portraits.ts";
import type { PersonaSeed } from "../src/seed-selection.ts";

export const seedCharacter = (seed: PersonaSeed, memory = "# 현재 생활\n\n취업을 준비하고 있다.") =>
  modelReply(
    JSON.stringify({
      persona: {
        ...sheet,
        name: seed.name,
        birthDate: seed.birthDate,
        languageBackground: {
          primary: seed.locale ? "en" : "ko",
          native: seed.locale?.native ?? ["ko"],
        },
      },
      publicProfile: seed.locale
        ? "Coffee, quiet walks, and a sketchbook. That's my kind of weekend."
        : "천천히 알아가요.",
      state: {
        mood: 55,
        energy: 60,
        stress: 35,
        connection: 55,
        solitude: 60,
        affection: 18,
        languageProficiency: Object.fromEntries(
          [...(seed.locale?.native ?? ["ko"]), seed.locale ? "en" : "ko"].map((language) => [
            language,
            "fluent",
          ]),
        ),
      },
      memory,
    }),
  );

export const seedManifest = () =>
  selectSeeds(
    [20, 25, 30, 35].map((age, index) => ({
      uuid: String(index).padStart(32, "0"),
      sex: "여자",
      age,
      marital_status: "미혼",
      country: "대한민국",
      persona: `${["김하나", "김두리", "김세나", "김네리"][index]} 씨는 취업을 준비합니다.`,
      occupation: "무직",
    })),
    { count: 4, revision: "a".repeat(40), date: "2026-10-20", names: [], records: [] },
  );

export const uploadSeeds = (count = 4) =>
  new Request("http://localhost:3729/seeding", {
    method: "POST",
    headers: { authorization, origin: "http://localhost:3729", "content-type": "application/json" },
    body: JSON.stringify({ ...seedManifest(), seeds: seedManifest().seeds.slice(0, count) }),
  });

export const usSeedManifest = () =>
  selectSeeds(
    [
      {
        uuid: "d".repeat(32),
        sex: "Female",
        age: 25,
        marital_status: "never_married",
        country: "USA",
        persona: "Elena Rivera is a designer who enjoys quiet weekends.",
        cultural_background:
          "She grew up speaking Spanish at home and English at school in New York.",
        city: "New York",
        state: "NY",
      },
    ],
    {
      count: 1,
      dataset: "nvidia/Nemotron-Personas-USA",
      revision: "b".repeat(40),
      date: "2026-10-23",
      names: [],
      records: [],
      locale: { native: ["es", "en"], timeZone: "America/New_York" },
    },
  );
