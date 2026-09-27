import { applyTransition, createSession, emit, recordInput } from "@repo/persona-engine";
import type { Change, Definition, Event, Model, Proposal, Session } from "@repo/persona-engine";
import type { Action, Judge, Judgment, Trigger } from "./judge.ts";
import { transition } from "./transition.ts";

const INTERVAL_MS = 5 * 60_000;
export const ABSORB_MS = 60_000;

export type Decision = {
  id: string;
  at: number;
  trigger: Trigger;
  requested: Action | "error";
  action: Action | "error";
  probabilities: Partial<Record<Action, number>>;
  pendingIds: string[];
  shifts: Judgment["shifts"];
  applied: Change[];
  meaningfulAbsence: boolean;
  window: string | null;
  replyId: string | null;
  error?: string;
};
export type Entry =
  | { type: "input"; event: Event; at?: number }
  | { type: "transition"; id: string; changes: Change[] }
  | { type: "reply"; id: string; proposal: Proposal }
  | { type: "unit"; id: string; reason: string };
export type Character = {
  session: Session;
  entries: Entry[];
  decisions: Decision[];
  nextCheckAt: number;
  offset: number;
  lastSentAt: number | null;
};
export type Outcome = { character: Character; decision: Decision; changes: Change[] };

export const begin = (definition: Definition, id: string, at: number): Character => ({
  session: createSession(definition, id),
  entries: [],
  decisions: [],
  nextCheckAt: at + INTERVAL_MS,
  offset: 0,
  lastSentAt: null,
});

export const admit = (character: Character, event: Event, at?: number): Character => ({
  ...character,
  session: recordInput(character.session, event),
  entries: [
    ...character.entries,
    { type: "input", event: structuredClone(event), ...(at === undefined ? {} : { at }) },
  ],
});

export const pendingFor = (session: Session): Event[] => {
  const lastReply = session.events.findLastIndex((event) => event.kind === "reply");
  return session.events.slice(lastReply + 1).filter((event) => event.kind === "user");
};

const windowFor = (character: Character, at: number): string | null => {
  const lastInput = character.decisions.findLast((item) => item.trigger === "input")?.at;
  const contact = Math.max(lastInput ?? 0, character.lastSentAt ?? 0);
  if (!contact) return null;
  const elapsed = at - contact;
  const band =
    elapsed >= 86_400_000
      ? "day"
      : elapsed >= 7_200_000
        ? "hours"
        : elapsed >= 1_800_000
          ? "half_hour"
          : null;
  if (!band) return null;
  const window = `${contact}:${band}`;
  return character.decisions.some((item) => item.window === window) ? null : window;
};

const actionFor = (requested: Action, pendingCount: number, lastSentAt: number | null): Action => {
  if (requested === "send_now" && pendingCount === 0) return "wait_for_user";
  if (requested === "initiate" && pendingCount > 0) return "send_now";
  if (requested === "hold" && pendingCount === 0) return "wait_for_user";
  if (requested === "nudge") {
    if (pendingCount > 0) return "send_now";
    if (lastSentAt === null) return "wait_for_user";
  }
  return requested;
};

const nextCheckAtFor = (at: number, action: Action): number =>
  at + (action === "hold" ? ABSORB_MS : INTERVAL_MS);

const replyWith = (
  session: Session,
  replyId: string,
  proposal: Proposal,
  unitEnded: boolean,
): { session: Session; entries: Entry[] } => {
  const result = emit(session, replyId, proposal);
  const unit: Entry | null = unitEnded
    ? { type: "unit", id: replyId, reason: `대화 단위 ${replyId}` }
    : null;
  return {
    session: unit
      ? applyTransition(result.state, [{ kind: "unit", reason: unit.reason }])
      : result.state,
    entries: [
      { type: "reply", id: replyId, proposal: structuredClone(proposal) },
      ...(unit ? [unit] : []),
    ],
  };
};

const recentTransitions = (decisions: Decision[]) =>
  decisions.map((item) => ({
    at: item.at,
    applied: item.applied.map(
      (change) => `${change.kind}.${"field" in change ? change.field : change.kind}`,
    ),
  }));

export const decide = async (
  character: Character,
  trigger: Trigger,
  at: number,
  id: string,
  judge: Judge,
  model: Model,
): Promise<Outcome> => {
  if (!id || character.decisions.some((item) => item.id === id))
    throw new Error("Duplicate decision ID");
  const pending = pendingFor(character.session);
  const lastInputAt = character.decisions.findLast((item) => item.trigger === "input")?.at ?? null;
  const window = trigger === "tick" ? windowFor(character, at) : null;
  const serviceBlocked = character.decisions.some(
    (item) => item.error && (character.lastSentAt === null || item.at > character.lastSentAt),
  );
  const base = { ...character, nextCheckAt: at + INTERVAL_MS };
  const details = { id, at, trigger, pendingIds: pending.map((event) => event.id) };
  if (character.session.stage === "ended") {
    const decision: Decision = {
      ...details,
      requested: "wait_for_user",
      action: "wait_for_user",
      probabilities: {},
      shifts: {},
      applied: [],
      meaningfulAbsence: false,
      window: null,
      replyId: null,
    };
    return {
      character: { ...base, decisions: [...character.decisions, decision] },
      decision,
      changes: [],
    };
  }
  let judgment: Awaited<ReturnType<Judge>>;
  try {
    judgment = await judge({
      session: character.session,
      at,
      trigger,
      pending,
      lastSentAt: character.lastSentAt,
      lastInputAt,
      previous: recentTransitions(character.decisions),
      serviceBlocked,
    });
  } catch (error) {
    const decision: Decision = {
      ...details,
      requested: "error",
      action: "error",
      probabilities: {},
      shifts: {},
      applied: [],
      meaningfulAbsence: false,
      window: null,
      replyId: null,
      error: error instanceof Error ? error.message : "Decision failed",
    };
    return {
      character: { ...base, decisions: [...character.decisions, decision] },
      decision,
      changes: [],
    };
  }
  const sourceId = character.session.events.at(-1)?.id ?? id;
  const changes = transition({
    session: character.session,
    judgment,
    trigger,
    sourceId,
    window,
    serviceBlocked,
  });
  const action = actionFor(judgment.action, pending.length, character.lastSentAt);
  const progressed: Character = {
    ...character,
    nextCheckAt: nextCheckAtFor(at, action),
    session: applyTransition(character.session, changes),
    entries: changes.length
      ? [...character.entries, { type: "transition", id, changes }]
      : character.entries,
  };
  const assessed = {
    ...details,
    requested: judgment.action,
    action,
    probabilities: judgment.probabilities,
    shifts: judgment.shifts,
    applied: changes,
    meaningfulAbsence: judgment.meaningfulAbsence,
    window,
  };
  const shouldSend = action === "send_now" || action === "initiate" || action === "nudge";
  if (!shouldSend) {
    const decision: Decision = { ...assessed, replyId: null };
    return {
      character: { ...progressed, decisions: [...character.decisions, decision] },
      decision,
      changes,
    };
  }
  try {
    const replyId = `${id}:reply`;
    const context: Event = {
      id: replyId,
      kind: "life",
      text: `가상 시각 ${new Date(at).toISOString()}: 최근 대화를 고려해 자연스럽게 연락한다`,
    };
    const proposal = await model(structuredClone(progressed.session), context);
    if (proposal.changes.length) throw new Error("Gemini cannot change state");
    const result = replyWith(progressed.session, replyId, proposal, judgment.unitEnded);
    const decision: Decision = { ...assessed, replyId };
    return {
      character: {
        ...progressed,
        session: result.session,
        entries: [...progressed.entries, ...result.entries],
        decisions: [...character.decisions, decision],
        lastSentAt: at,
      },
      decision,
      changes,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Generation failed";
    const decision: Decision = { ...assessed, replyId: null, error: message };
    return {
      character: { ...progressed, decisions: [...character.decisions, decision] },
      decision,
      changes,
    };
  }
};
