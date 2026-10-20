import { expect, test } from "vitest";
import { selectSeeds } from "./seed-selection.ts";
import { seedManifest } from "../test/seeding.ts";

test.each([0, 1, 2, 3])(
  "a single-person preview can select age band %i without adding siblings",
  (band) => {
    const manifest = seedManifest();
    const rows = manifest.seeds.map((seed) => seed.source);
    const selected = selectSeeds(rows, {
      count: 1,
      revision: manifest.revision,
      date: manifest.date,
      names: [],
      records: manifest.seeds.slice(0, band).map((seed) => seed.uuid),
    });
    expect(selected.seeds).toEqual([manifest.seeds[band]]);
  },
);

test("the seed command selects four age bands, preserving source facts and skipping names already used", () => {
  const rows = [20, 25, 30, 35, 39].map((age, i) => ({
    uuid: String(i).padStart(32, "0"),
    sex: "여자",
    age,
    marital_status: "미혼",
    persona: `${["김하나", "김두리", "김세나", "김네리", "김다희"][i]} 씨는 취업을 준비합니다.`,
    occupation: "무직",
    country: "대한민국",
  }));
  const manifest = selectSeeds(rows, {
    count: 4,
    revision: "a".repeat(40),
    date: "2026-10-20",
    names: ["김네리"],
    records: [],
  });
  expect(manifest.seeds.map((seed) => [seed.name, seed.age, seed.birthDate])).toEqual([
    ["김하나", 20, "2006-10-20"],
    ["김두리", 25, "2001-10-20"],
    ["김세나", 30, "1996-10-20"],
    ["김다희", 39, "1987-10-20"],
  ]);
  expect(manifest.seeds[0]!.source).toEqual(rows[0]);
});

test("selection skips ineligible, ambiguous, duplicate and consumed seeds without backfilling a different age band", () => {
  const manifest = seedManifest();
  const rows = manifest.seeds.map((seed) => seed.source);
  const first = rows[0]!;
  const excluded = [
    { ...first, sex: "남자" },
    { ...first, age: 19 },
    { ...first, age: 40 },
    { ...first, age: "20" },
    { ...first, age: 20.5 },
    { ...first, marital_status: "기혼" },
    { ...first, persona: "이름이 모호함" },
    { ...first, persona: 1 },
    { ...first, uuid: 1 },
    { ...first, uuid: "f".repeat(32) },
  ];
  const options = {
    count: 4,
    revision: manifest.revision,
    date: manifest.date,
    names: [],
    records: ["f".repeat(32)],
  };
  const extra = { ...first, uuid: "e".repeat(32), persona: "박초과 씨는 취업을 준비합니다." };
  expect(selectSeeds([...excluded, first, extra, first, ...rows], options)).toEqual(manifest);
  expect(() => selectSeeds(rows.slice(1), options)).toThrow("Not enough distinct eligible seeds");
  for (const count of [0, 3, 201, 4.5])
    expect(() => selectSeeds(rows, { ...options, count })).toThrow(
      "Invalid or conflicting seeding manifest",
    );
});

test("selection assigns valid age-consistent birthdays on leap days and rejects unverifiable source fields", () => {
  const manifest = seedManifest();
  const options = {
    count: 4,
    revision: manifest.revision,
    date: "2024-02-29",
    names: [],
    records: [],
  };
  const rows = manifest.seeds.map((seed) => seed.source);
  expect(selectSeeds(rows, options).seeds.map((seed) => seed.birthDate)).toEqual([
    "2004-02-29",
    "1999-02-28",
    "1994-02-28",
    "1989-02-28",
  ]);
  expect(() => selectSeeds(rows, { ...options, date: "invalid" })).toThrow(
    "Invalid or conflicting seeding manifest",
  );
  expect(() =>
    selectSeeds(
      rows.map((row) => ({ ...row, country: "unknown" })),
      options,
    ),
  ).toThrow("Invalid or conflicting seeding manifest");
});
