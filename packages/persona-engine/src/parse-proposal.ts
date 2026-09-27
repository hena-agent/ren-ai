import { STAGES } from "./stages.ts";
import type { Change, Condition, Mutable, Proposal, Relationship, Trait } from "./types.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow parsed model JSON before the engine sees it
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow parsed model JSON strings
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow parsed model JSON numbers
const numeric = (value: unknown): number => {
  if (typeof value !== "number") throw new Error("Expected number");
  return value;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow parsed model JSON booleans
const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Expected boolean");
  return value;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow parsed model JSON arrays
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value.map(text);
};

const choice = <T extends string>(value: string, options: readonly T[]): T => {
  const found = options.find((option) => option === value);
  if (!found) throw new Error(`Invalid choice: ${value}`);
  return found;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow a proposed trait from model JSON
const trait = (value: unknown): Trait => {
  const data = record(value);
  return {
    id: text(data["id"]),
    name: text(data["name"]),
    strength: numeric(data["strength"]),
    context: text(data["context"]),
    scope: choice(text(data["scope"]), ["personal", "relationship"]),
    persistence: choice(text(data["persistence"]), ["situational", "lasting"]),
    origin: choice(text(data["origin"]), ["hidden", "formed"]),
    revealed: boolean(data["revealed"]),
    active: boolean(data["active"]),
    evidence: strings(data["evidence"]),
    reason: text(data["reason"]),
  };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow a proposed change from model JSON
const change = (value: unknown): Change => {
  const data = record(value);
  switch (text(data["kind"])) {
    case "condition":
      return {
        kind: "condition",
        field: choice(text(data["field"]), [
          "mood",
          "energy",
          "stress",
          "connection",
          "solitude",
          "disappointment",
        ] satisfies readonly (keyof Condition)[]),
        value: numeric(data["value"]),
        reason: text(data["reason"]),
      };
    case "mutable":
      return {
        kind: "mutable",
        field: choice(text(data["field"]), [
          "openness",
          "guardedness",
          "initiative",
        ] satisfies readonly (keyof Mutable)[]),
        value: numeric(data["value"]),
        reason: text(data["reason"]),
      };
    case "relationship":
      return {
        kind: "relationship",
        field: choice(text(data["field"]), [
          "familiarity",
          "trust",
          "affection",
        ] satisfies readonly (keyof Relationship)[]),
        value: numeric(data["value"]),
        reason: text(data["reason"]),
      };
    case "stage":
      return {
        kind: "stage",
        stage: choice(text(data["stage"]), STAGES),
        reason: text(data["reason"]),
      };
    case "unit":
      return { kind: "unit", reason: text(data["reason"]) };
    case "form":
      return { kind: "form", trait: trait(data["trait"]) };
    case "reveal":
      return {
        kind: "reveal",
        traitId: text(data["traitId"]),
        evidence: text(data["evidence"]),
        reason: text(data["reason"]),
      };
    case "revise":
      return {
        kind: "revise",
        traitId: text(data["traitId"]),
        strength: numeric(data["strength"]),
        persistence: choice(text(data["persistence"]), [
          "situational",
          "lasting",
        ] satisfies readonly Trait["persistence"][]),
        active: boolean(data["active"]),
        evidence: text(data["evidence"]),
        reason: text(data["reason"]),
      };
    default:
      throw new Error("Invalid change kind");
  }
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parse untrusted JSON from an AI model
export const parseProposal = (value: unknown): Proposal => {
  const data = record(value);
  return { reply: text(data["reply"]), changes: parseChanges(data["changes"]) };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: parse stored model changes before replay
export const parseChanges = (value: unknown): Change[] => {
  if (!Array.isArray(value)) throw new Error("Expected changes array");
  return value.map(change);
};
