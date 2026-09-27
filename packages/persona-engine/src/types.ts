import type { Stage } from "./stages.ts";

type Base = {
  autonomy: number;
  sociability: number;
  initiative: number;
  sensitivity: number;
  expression: number;
  novelty: number;
};

export type Condition = {
  mood: number;
  energy: number;
  stress: number;
  connection: number;
  solitude: number;
  disappointment: number;
};

export type Relationship = { familiarity: number; trust: number; affection: number };
export type Mutable = { openness: number; guardedness: number; initiative: number };

export type Trait = {
  id: string;
  name: string;
  strength: number;
  context: string;
  scope: "personal" | "relationship";
  persistence: "situational" | "lasting";
  origin: "hidden" | "formed";
  revealed: boolean;
  active: boolean;
  evidence: string[];
  reason: string;
};

export type Definition = {
  name: string;
  profile: string;
  base: Base;
  condition: Condition;
  mutable: Mutable;
  relationship: Relationship;
  hidden: Trait[];
  gender: string;
  contactExpectation: string;
  startStage?: Stage;
  speech?: string;
  samples?: string[];
};

export type Event = { id: string; kind: "user" | "life" | "reply"; text: string };
export type Session = {
  id: string;
  definition: Definition;
  stage: Stage;
  condition: Condition;
  mutable: Mutable;
  relationship: Relationship;
  traits: Trait[];
  events: Event[];
  unitStart: number;
};

export type Change =
  | { kind: "condition"; field: keyof Condition; value: number; reason: string }
  | { kind: "mutable"; field: keyof Mutable; value: number; reason: string }
  | { kind: "relationship"; field: keyof Relationship; value: number; reason: string }
  | { kind: "stage"; stage: Stage; reason: string }
  | { kind: "unit"; reason: string }
  | { kind: "form"; trait: Trait }
  | { kind: "reveal"; traitId: string; evidence: string; reason: string }
  | {
      kind: "revise";
      traitId: string;
      strength: number;
      persistence: Trait["persistence"];
      active: boolean;
      evidence: string;
      reason: string;
    };

export type Proposal = { reply: string; changes: Change[] };
export type Model = (state: Session, input: Event) => Promise<Proposal>;
export type Turn = { state: Session; reply: string; changes: Change[] };
