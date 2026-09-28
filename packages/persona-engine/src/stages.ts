export const STAGES = [
  "stranger",
  "acquaintance",
  "familiar",
  "flirting",
  "dating",
  "ended",
] as const;

export type Stage = (typeof STAGES)[number];

export const ACTIVE_STAGES = [
  "stranger",
  "acquaintance",
  "familiar",
  "flirting",
  "dating",
] as const;

export type StageCaps = { familiarity: number; trust: number; affection: number };

export const stageIndex = (stage: Stage): number =>
  ACTIVE_STAGES.findIndex((candidate) => candidate === stage);

const GATES: Record<Stage, StageCaps> = {
  stranger: { familiarity: 0, trust: 0, affection: 0 },
  acquaintance: { familiarity: 15, trust: 25, affection: 0 },
  familiar: { familiarity: 40, trust: 45, affection: 25 },
  flirting: { familiarity: 60, trust: 65, affection: 45 },
  dating: { familiarity: 80, trust: 80, affection: 70 },
  ended: { familiarity: 100, trust: 100, affection: 100 },
};

const CAPS: Record<Stage, StageCaps> = {
  stranger: { familiarity: 35, trust: 45, affection: 25 },
  acquaintance: { familiarity: 60, trust: 65, affection: 45 },
  familiar: { familiarity: 80, trust: 80, affection: 70 },
  flirting: { familiarity: 95, trust: 90, affection: 90 },
  dating: { familiarity: 100, trust: 100, affection: 100 },
  ended: { familiarity: 100, trust: 100, affection: 100 },
};

export const gateFor = (stage: Stage): StageCaps => GATES[stage];

export const capsFor = (stage: Stage): StageCaps => CAPS[stage];

const meets = (relationship: StageCaps, gate: StageCaps): boolean =>
  relationship.familiarity >= gate.familiarity &&
  relationship.trust >= gate.trust &&
  relationship.affection >= gate.affection;

/**
 * A stage change is only valid between adjacent stages, except that any active
 * stage may end the relationship. Step-down is allowed only up to `familiar`;
 * from `flirting` or `dating` the only negative outcome is `ended`.
 */
export const canTransitionStage = (
  current: Stage,
  target: Stage,
  relationship: StageCaps,
): boolean => {
  if (current === "ended") return false;
  if (target === "ended") return true;
  const from = stageIndex(current);
  const to = stageIndex(target);
  if (to === from + 1) return meets(relationship, gateFor(target));
  if (to === from - 1) return from <= stageIndex("familiar");
  return false;
};
