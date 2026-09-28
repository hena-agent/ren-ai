import { canTransitionStage, capsFor } from "@repo/persona-engine";
import type { Change, Relationship, Session } from "@repo/persona-engine";
import type { Judgment, Step, Trigger } from "./judge.ts";

const stepValue: Record<Step, number> = {
  fall_clear: -3,
  fall_slight: -1,
  stable: 0,
  rise_slight: 1,
  rise_clear: 3,
};

export type TransitionContext = {
  session: Session;
  judgment: Judgment;
  trigger: Trigger;
  sourceId: string;
  window: string | null;
  serviceBlocked: boolean;
};

const adjusted = (before: number, step: Step, trigger: Trigger): number => {
  const delta = stepValue[step];
  return Math.max(0, Math.min(100, before + (trigger === "tick" ? Math.sign(delta) : delta)));
};

const conditionChange = (
  axis: string,
  step: Step,
  ctx: TransitionContext,
  reason: string,
): Change | null => {
  const field = (
    ["mood", "energy", "stress", "connection", "solitude", "disappointment"] as const
  ).find((name) => axis === `condition.${name}`);
  if (!field) return null;
  if (
    ctx.trigger === "tick" &&
    field === "disappointment" &&
    (!ctx.judgment.meaningfulAbsence || ctx.serviceBlocked)
  )
    return null;
  const value = adjusted(ctx.session.condition[field], step, ctx.trigger);
  return value === ctx.session.condition[field]
    ? null
    : { kind: "condition", field, value, reason };
};

const mutableChange = (
  axis: string,
  step: Step,
  ctx: TransitionContext,
  reason: string,
): Change | null => {
  const field = (["openness", "guardedness", "initiative"] as const).find(
    (name) => axis === `mutable.${name}`,
  );
  if (!field) return null;
  if (ctx.trigger === "tick" && (!ctx.judgment.meaningfulAbsence || ctx.serviceBlocked))
    return null;
  const value = adjusted(ctx.session.mutable[field], step, ctx.trigger);
  return value === ctx.session.mutable[field] ? null : { kind: "mutable", field, value, reason };
};

const relationshipChange = (
  axis: string,
  step: Step,
  ctx: TransitionContext,
  reason: string,
  relationship: Relationship,
): Change | null => {
  const field = (["familiarity", "trust", "affection"] as const).find(
    (name) => axis === `relationship.${name}`,
  );
  if (!field) return null;
  if (ctx.trigger === "tick" && (!ctx.judgment.meaningfulAbsence || ctx.serviceBlocked))
    return null;
  const value = Math.min(
    capsFor(ctx.session.stage)[field],
    adjusted(ctx.session.relationship[field], step, ctx.trigger),
  );
  if (value === ctx.session.relationship[field]) return null;
  relationship[field] = value;
  return { kind: "relationship", field, value, reason };
};

const stageChange = (
  ctx: TransitionContext,
  relationship: Relationship,
  reason: string,
): Change | null => {
  if (ctx.trigger !== "input") return null;
  if (!canTransitionStage(ctx.session.stage, ctx.judgment.stage, relationship)) return null;
  return { kind: "stage", stage: ctx.judgment.stage, reason };
};

export const transition = (ctx: TransitionContext): Change[] => {
  if (ctx.trigger === "tick" && !ctx.window) return [];
  const reason = ctx.trigger === "input" ? `사건 ${ctx.sourceId}` : `시간 경과 ${ctx.window}`;
  const changes: Change[] = [];
  const relationship = { ...ctx.session.relationship };
  for (const [axis, step] of Object.entries(ctx.judgment.shifts)) {
    if (!Object.hasOwn(stepValue, step)) continue;
    const change =
      conditionChange(axis, step, ctx, reason) ??
      mutableChange(axis, step, ctx, reason) ??
      relationshipChange(axis, step, ctx, reason, relationship);
    if (change) changes.push(change);
  }
  const stage = stageChange(ctx, relationship, reason);
  if (stage) changes.push(stage);
  return changes;
};
