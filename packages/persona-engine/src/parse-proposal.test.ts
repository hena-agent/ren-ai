import { expect, it } from "vitest";
import { parseProposal } from "./index.ts";

const formed = {
  id: "f1",
  name: "밤 산책",
  strength: 45,
  context: "비 오는 밤",
  scope: "personal",
  persistence: "situational",
  origin: "formed",
  revealed: true,
  active: true,
  evidence: ["e1"],
  reason: "스스로 선택했다",
};

it("narrows every proposed change", () => {
  const changes = [
    { kind: "condition", field: "mood", value: 70, reason: "기뻐서" },
    { kind: "relationship", field: "trust", value: 40, reason: "약속을 지켜서" },
    { kind: "stage", stage: "acquaintance", reason: "알아가기" },
    { kind: "form", trait: formed },
    { kind: "reveal", traitId: "h1", evidence: "e1", reason: "드러남" },
    {
      kind: "revise",
      traitId: "f1",
      strength: 60,
      persistence: "lasting",
      active: true,
      evidence: "e1",
      reason: "반복",
    },
  ];
  expect(parseProposal({ reply: "안녕", changes })).toEqual({ reply: "안녕", changes });
});

it("accepts each shared Stat, trait origin, scope and duration without substituting another", () => {
  for (const field of ["mood", "energy", "stress", "connection", "solitude", "disappointment"]) {
    const entry = { kind: "condition", field, value: 100, reason: "사건" };
    expect(parseProposal({ reply: "답장", changes: [entry] }).changes).toEqual([entry]);
  }
  for (const field of ["familiarity", "trust", "affection"]) {
    const entry = { kind: "relationship", field, value: 0, reason: "사건" };
    expect(parseProposal({ reply: "답장", changes: [entry] }).changes).toEqual([entry]);
  }
  for (const field of ["openness", "guardedness", "initiative"]) {
    const entry = { kind: "mutable", field, value: 44, reason: "사건" };
    expect(parseProposal({ reply: "답장", changes: [entry] }).changes).toEqual([entry]);
  }
  for (const stage of ["stranger", "acquaintance", "familiar", "flirting", "dating", "ended"]) {
    const entry = { kind: "stage", stage, reason: "전환" };
    expect(parseProposal({ reply: "답장", changes: [entry] }).changes).toEqual([entry]);
  }
  for (const scope of ["personal", "relationship"])
    for (const origin of ["hidden", "formed"])
      for (const persistence of ["situational", "lasting"]) {
        const candidate = { ...formed, scope, origin, persistence };
        expect(
          parseProposal({ reply: "답장", changes: [{ kind: "form", trait: candidate }] }).changes,
        ).toEqual([{ kind: "form", trait: candidate }]);
      }
  const revision = {
    kind: "revise",
    traitId: "f1",
    strength: 30,
    persistence: "situational",
    active: false,
    evidence: "e1",
    reason: "바뀜",
  };
  expect(parseProposal({ reply: "답장", changes: [revision] }).changes).toEqual([revision]);
});

it("rejects malformed model JSON at the trust boundary", () => {
  const good = { reply: "안녕", changes: [] };
  for (const value of [null, [], 5, "text"])
    expect(() => parseProposal(value)).toThrow("Expected object");
  for (const value of [
    { ...good, reply: 1 },
    { ...good, changes: "none" },
  ])
    expect(() => parseProposal(value)).toThrow(/Expected/);
  for (const value of [
    { kind: "condition", field: "invalid", value: 50, reason: "x" },
    { kind: "relationship", field: "invalid", value: 50, reason: "x" },
    { kind: "mutable", field: "invalid", value: 50, reason: "x" },
    { kind: "stage", stage: "invalid", reason: "x" },
    { kind: "stage", stage: "stranger", reason: 1 },
    { kind: "stage", reason: "x" },
    { kind: "form", trait: { ...formed, scope: "invalid" } },
    { kind: "form", trait: { ...formed, persistence: "invalid" } },
    { kind: "form", trait: { ...formed, origin: "invalid" } },
    { kind: "form", trait: { ...formed, evidence: "e1" } },
    { kind: "form", trait: { ...formed, evidence: [0] } },
    { kind: "form", trait: { ...formed, revealed: "yes" } },
    { kind: "form", trait: { ...formed, active: 1 } },
    { kind: "form", trait: { ...formed, strength: "50" } },
    { kind: "reveal", traitId: 1, evidence: "e1", reason: "x" },
    {
      kind: "revise",
      traitId: "f1",
      strength: 50,
      persistence: "invalid",
      active: true,
      evidence: "e1",
      reason: "x",
    },
    {
      kind: "revise",
      traitId: "f1",
      strength: 50,
      persistence: "lasting",
      active: "yes",
      evidence: "e1",
      reason: "x",
    },
    { kind: "invalid" },
  ])
    expect(() => parseProposal({ ...good, changes: [value] })).toThrow(/Expected|Invalid/);
});
