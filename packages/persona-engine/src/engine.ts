import { canTransitionStage, capsFor, STAGES } from "./stages.ts";
import type { Change, Definition, Event, Model, Proposal, Session, Trait, Turn } from "./types.ts";

const score = (value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > 100)
    throw new Error("Stat must be an integer from 0 to 100");
};

const scores = (values: Record<string, number>, fields: readonly string[]): void => {
  if (
    Object.keys(values).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(values, field))
  )
    throw new Error("Missing or unknown Stat");
  for (const value of Object.values(values)) score(value);
};

export const createSession = (definition: Definition, id: string): Session => {
  if (
    !id ||
    !definition.name ||
    !definition.profile ||
    !definition.gender ||
    !definition.contactExpectation
  )
    throw new Error("Session and Persona need identifiers and a profile");
  scores(definition.base, [
    "autonomy",
    "sociability",
    "initiative",
    "sensitivity",
    "expression",
    "novelty",
  ]);
  scores(definition.condition, [
    "mood",
    "energy",
    "stress",
    "connection",
    "solitude",
    "disappointment",
  ]);
  scores(definition.mutable, ["openness", "guardedness", "initiative"]);
  scores(definition.relationship, ["familiarity", "trust", "affection"]);
  for (const trait of definition.hidden) {
    score(trait.strength);
    if (
      !trait.id ||
      !trait.name ||
      !trait.context ||
      !trait.reason ||
      !["personal", "relationship"].includes(trait.scope) ||
      !["situational", "lasting"].includes(trait.persistence) ||
      trait.origin !== "hidden" ||
      trait.revealed ||
      !trait.active ||
      trait.evidence.length
    )
      throw new Error("Initial traits must be hidden and unrevealed");
  }
  if (new Set(definition.hidden.map((trait) => trait.id)).size !== definition.hidden.length)
    throw new Error("Duplicate initial trait ID");
  const stage = definition.startStage ?? "stranger";
  if (stage === "ended" || !STAGES.includes(stage)) throw new Error("Invalid start stage");
  const snapshot = structuredClone(definition);
  return {
    id,
    definition: snapshot,
    stage,
    condition: structuredClone(snapshot.condition),
    mutable: structuredClone(snapshot.mutable),
    relationship: structuredClone(snapshot.relationship),
    traits: structuredClone(snapshot.hidden),
    events: [],
    unitStart: 0,
  };
};

const evidenceFor = (ids: ReadonlySet<string>, evidence: string): void => {
  if (!ids.has(evidence)) throw new Error(`Unknown evidence: ${evidence}`);
};

const target = (traits: Trait[], id: string): Trait => {
  const trait = traits.find((item) => item.id === id);
  if (!trait || !trait.active) throw new Error(`Unknown active trait: ${id}`);
  return trait;
};

const form = (traits: Trait[], trait: Trait, ids: ReadonlySet<string>): void => {
  score(trait.strength);
  const valid =
    Boolean(trait.id && trait.name && trait.reason && trait.context) &&
    trait.origin === "formed" &&
    trait.revealed &&
    trait.active &&
    ["situational", "lasting"].includes(trait.persistence) &&
    ["personal", "relationship"].includes(trait.scope) &&
    !traits.some((item) => item.id === trait.id) &&
    trait.evidence.length > 0;
  if (!valid) throw new Error("Invalid new trait");
  for (const id of trait.evidence) evidenceFor(ids, id);
  traits.push(structuredClone(trait));
};

const applyUnit = (state: Session, change: Change & { kind: "unit" }): void => {
  if (!change.reason) throw new Error("Invalid unit change");
  state.unitStart = state.events.length;
};

const applyStage = (state: Session, change: Change & { kind: "stage" }): void => {
  if (!STAGES.includes(change.stage) || !change.reason) throw new Error("Invalid stage change");
  if (!canTransitionStage(state.stage, change.stage, state.relationship))
    throw new Error("Invalid stage transition");
  state.stage = change.stage;
};

const apply = (state: Session, change: Change, ids: ReadonlySet<string>): void => {
  switch (change.kind) {
    case "condition":
      score(change.value);
      if (!Object.hasOwn(state.condition, change.field) || !change.reason)
        throw new Error("Invalid condition change");
      state.condition[change.field] = change.value;
      return;
    case "mutable":
      score(change.value);
      if (!Object.hasOwn(state.mutable, change.field) || !change.reason)
        throw new Error("Invalid mutable change");
      state.mutable[change.field] = change.value;
      return;
    case "relationship":
      score(change.value);
      if (!Object.hasOwn(state.relationship, change.field) || !change.reason)
        throw new Error("Invalid relationship change");
      if (change.value > capsFor(state.stage)[change.field])
        throw new Error("Relationship exceeds stage cap");
      state.relationship[change.field] = change.value;
      return;
    case "stage":
      applyStage(state, change);
      return;
    case "unit":
      applyUnit(state, change);
      return;
    case "form":
      form(state.traits, change.trait, ids);
      return;
    case "reveal": {
      evidenceFor(ids, change.evidence);
      const trait = target(state.traits, change.traitId);
      if (trait.origin !== "hidden" || trait.revealed || !change.reason)
        throw new Error("Trait is not hidden");
      trait.revealed = true;
      trait.evidence.push(change.evidence);
      return;
    }
    case "revise": {
      evidenceFor(ids, change.evidence);
      score(change.strength);
      const trait = target(state.traits, change.traitId);
      if (!change.reason || !["situational", "lasting"].includes(change.persistence))
        throw new Error("Invalid revision");
      trait.strength = change.strength;
      trait.persistence = change.persistence;
      trait.active = change.active;
      trait.evidence.push(change.evidence);
      return;
    }
  }
};

export const advance = async (state: Session, input: Event, model: Model): Promise<Turn> => {
  if (
    !input.id ||
    !input.text ||
    input.kind === "reply" ||
    state.events.some((event) => event.id === input.id)
  )
    throw new Error("Invalid or duplicate input");
  const replyId = `${input.id}:reply`;
  if (state.events.some((event) => event.id === replyId)) throw new Error("Duplicate reply ID");
  const proposal = await model(structuredClone(state), structuredClone(input));
  if (!proposal.reply) throw new Error("Empty reply");
  const next = structuredClone(state);
  const ids = new Set([...state.events.map((event) => event.id), input.id, replyId]);
  for (const change of proposal.changes) apply(next, change, ids);
  next.events.push(structuredClone(input), { id: replyId, kind: "reply", text: proposal.reply });
  return { state: next, reply: proposal.reply, changes: structuredClone(proposal.changes) };
};

export const recordInput = (state: Session, input: Event): Session => {
  if (
    !input.id ||
    !input.text ||
    input.kind === "reply" ||
    state.events.some((event) => event.id === input.id)
  )
    throw new Error("Invalid or duplicate input");
  const next = structuredClone(state);
  next.events.push(structuredClone(input));
  return next;
};

export const emit = (state: Session, id: string, proposal: Proposal): Turn => {
  if (!id || !proposal.reply || state.events.some((event) => event.id === id))
    throw new Error("Invalid or duplicate reply");
  const next = structuredClone(state);
  const ids = new Set([...state.events.map((event) => event.id), id]);
  for (const change of proposal.changes) apply(next, change, ids);
  next.events.push({ id, kind: "reply", text: proposal.reply });
  return { state: next, reply: proposal.reply, changes: structuredClone(proposal.changes) };
};

export const applyTransition = (state: Session, changes: Change[]): Session => {
  const next = structuredClone(state);
  const ids = new Set(state.events.map((event) => event.id));
  for (const change of changes) apply(next, change, ids);
  return next;
};
