import { expect, test, vi } from "vitest";
import { stateStatus } from "./state-diagnostics.ts";
import { serializeInitialState } from "./initial.ts";
import { renderCharacterSheet } from "./character-sheet.ts";
import { initialTraits } from "./publication.ts";
import { sheet } from "../../../apps/admin/test/sheet.ts";

const persona = renderCharacterSheet(sheet);
const source = serializeInitialState({
  mood: 52,
  energy: 63,
  stress: 24,
  connection: 46,
  solitude: 57,
  traits: initialTraits(persona),
});

test("malformed collection keys never emit payload-bearing YAML warnings", () => {
  const warning = vi.spyOn(process, "emitWarning");
  try {
    stateStatus(source.replace("mood: 52", "? [private, secret]\n: 52"), persona);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
function selected(input: string, text: string, expected = text) {
  const issue = stateStatus(input, persona).issues.find((entry) => entry.message.includes(text))!;
  expect(issue).toBeDefined();
  expect(input.slice(issue.start, issue.end)).toContain(expected);
  return issue;
}

test("valid State shares the schema and trait validation with publication, including aliases and CRLF", () => {
  expect(stateStatus(source, persona)).toMatchObject({
    state: "valid",
    label: "형식 정상",
    issues: [],
  });
  expect(stateStatus(source)).toMatchObject({ state: "valid", issues: [] });
  expect(stateStatus("  \n")).toMatchObject({ state: "empty", label: "초기값 없음" });
  expect(stateStatus(source.replaceAll("\n", "\r\n"), persona).state).toBe("valid");
  expect(
    stateStatus(
      source.replace("mood: 52", "mood: &mood 52").replace("energy: 63", "energy: *mood"),
      persona,
    ).state,
  ).toBe("valid");
  expect(
    stateStatus(
      serializeInitialState({
        mood: 0,
        energy: 100,
        stress: 0,
        connection: 100,
        solitude: 0,
        traits: {},
      }),
      renderCharacterSheet({ ...sheet, hidden: [] }),
    ).state,
  ).toBe("valid");
});

test("all numeric, boolean, persistence and extra-field errors have exact YAML ranges", () => {
  const bad = source
    .replace("mood: 52", "mood: 101")
    .replace("energy: 63", "energy: 2.5")
    .replace("active: true", 'active: "yes"')
    .replace("persistence: lasting", "persistence: transient");
  expect(stateStatus(bad, persona).issues).toHaveLength(4);
  const mood = selected(bad, "mood", "mood: 101");
  expect(mood.line).toBe(2);
  selected(bad, "energy", "energy: 2.5");
  selected(bad, "active", 'active: "yes"');
  selected(bad, "persistence", "persistence: transient");
  selected(source.replace("traits:", "unknown: 10\ntraits:"), "unknown", "unknown: 10");
  const wrongTraits = source.replace(/traits:[\s\S]*?---/, "traits: []\n---");
  selected(wrongTraits, "traits", "traits: []");
  expect(stateStatus("---\n42\n---", persona).issues[0]?.message).toContain("YAML 객체");
  expect(stateStatus("---\n\n---", persona).state).toBe("invalid");
  expect(stateStatus(source.replace("mood: 52", "? [one, two]\n: 52"), persona).state).toBe(
    "invalid",
  );
});

test("missing and mismatched trait values point to the actual trait or the insertion position", () => {
  selected(source.replace("strength: 80", "strength: 79"), "강도 80", "strength: 79");
  const extra = source.replace(
    "traits:",
    "traits:\n  새로운 특성:\n    strength: 10\n    active: true\n    persistence: lasting",
  );
  selected(extra, "Persona에 없는", "새로운 특성:");
  const missing = source.replace("mood: 52\n", "");
  const issue = stateStatus(missing, persona).issues.find((entry) =>
    entry.message.includes("mood"),
  )!;
  expect(issue.start).toBe(issue.end);
  expect(issue.start).toBeGreaterThan(missing.indexOf("traits:"));
  const missingTrait = source.replace(/traits:[\s\S]*?---/, "traits: {}\n---");
  expect(stateStatus(missingTrait, persona).issues[0]?.message).toContain("강도 80");
  expect(stateStatus(source, "불완전한 Persona").issues[0]?.message).toContain("Persona 형식");
  const emptyKey = source.replace("도움 요청 회피:", '" ":');
  expect(stateStatus(emptyKey, persona).state).toBe("invalid");
  const alias = source
    .replace("도움 요청 회피:", "other: &trait")
    .replace("strength: 80", "strength: 79")
    .replace("persistence: lasting\n", "persistence: lasting\n  도움 요청 회피: *trait\n");
  selected(alias, "강도 80", "도움 요청 회피: *trait");
  expect(
    stateStatus(
      source.replace(/traits:[\s\S]*?---/, "traits: !!set {도움 요청 회피}\n---"),
      persona,
    ).state,
  ).toBe("invalid");
});

test("syntax, duplicate keys, unresolved references and malformed document envelopes are safe diagnostics", () => {
  for (const broken of ["mood: 52", "plain", "plain\ntext", source + "extra body"])
    expect(stateStatus(broken, persona).issues[0]?.message).toContain("frontmatter");
  for (const replacement of ["mood: [", "mood: 52\nmood: 30"]) {
    const input = source.replace("mood: 52", replacement);
    const result = stateStatus(input, persona);
    expect(result.state).toBe("invalid");
    expect(result.issues[0]?.message).toContain("YAML 문법");
    expect(result.issues[0]?.start).toBeGreaterThan(0);
  }
  expect(
    stateStatus(source.replace("mood: 52", "mood: *missing"), persona).issues[0]?.message,
  ).toContain("참조");
  expect(stateStatus(source + " ".repeat(16000), persona).issues[0]?.start).toBe(16000);
});
