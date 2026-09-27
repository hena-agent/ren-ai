import { STAGES } from "@repo/persona-engine";
import type { Event, Session, Stage } from "@repo/persona-engine";

const criteria = {
  fall_clear: "Strong evidence of a lasting decrease caused by the new event.",
  fall_slight: "Some evidence of a small decrease.",
  stable: "No new evidence to change this specific dimension.",
  rise_slight: "Some evidence of a small increase.",
  rise_clear: "Strong evidence of a lasting increase caused by the new event.",
} as const;

const axes = {
  "condition.mood":
    "Does their current mood shift in response to this event or meaningful elapsed time?",
  "condition.energy": "Does their energy change because of a concrete event or their daily rhythm?",
  "condition.stress":
    "Does their stress change due to new information or a meaningful passage of time?",
  "condition.connection": "Does their wish to connect with others change?",
  "condition.solitude": "Does their wish for time alone change?",
  "condition.disappointment":
    "Is there a new reason for disappointment, such as an unmet personal expectation? Do not repeatedly count the same delay.",
  "mutable.openness":
    "Does their willingness to share personal things change? This is not their fixed expressiveness.",
  "mutable.guardedness": "Does their guardedness change after this experience?",
  "mutable.initiative":
    "Does their current willingness to take initiative change? This is not their fixed temperament.",
  "relationship.familiarity": "Did the two learn something meaningful about each other?",
  "relationship.trust": "Did an observed action or meaningful broken expectation change trust?",
  "relationship.affection":
    "Did something meaningful change their affection? Do not equate payment, message count, or technical silence with affection.",
} as const;

export const stageGuidance: Record<Stage, string> = {
  stranger:
    "You have just met. You know nothing about them. Do not reference shared history, do not use pet names, and do not assume closeness. This is about what you may claim to know, not about sounding formal.",
  acquaintance:
    "You have talked a few times. Small talk and light curiosity are fine, but deep personal disclosures and romantic affection are premature.",
  familiar:
    "You are comfortable with each other. Jokes and catching up are natural, but do not behave like a romantic partner.",
  flirting:
    "There is mutual romantic tension. You may show affection and excitement, but do not assume certainty or ownership.",
  dating: "You are partners. You may express affection, make plans, and rely on each other.",
  ended: "The relationship is over. You do not contact them.",
};

const stageCriteria: Record<Stage, string> = {
  stranger: "You have just met and barely know them.",
  acquaintance: "You are getting to know each other. Only a small step forward with real evidence.",
  familiar: "You are comfortable, but not romantic yet.",
  flirting: "There is mutual romantic tension.",
  dating: "You are partners.",
  ended: "End the relationship. Allowed from any stage; it cannot be undone.",
};

export const questions = {
  stage: {
    type: "choice",
    instructions:
      "What is the relationship stage after this event? Keep the current stage unless there is genuine new evidence. Move one step forward only if the relationship stats already support it. Step back one stage only in the early stages; from flirting or dating the only negative outcome is ended. Never skip a stage.",
    criteria: stageCriteria,
  },
  action: {
    type: "choice",
    instructions:
      "What should this person do next? People often send several short messages in a row; treat consecutive pending user messages as one utterance and answer them together rather than one by one. If the user may still be typing, hold and reconsider shortly. Reacting immediately is not required.",
    criteria: {
      send_now: "Reply now because there is an unanswered user message.",
      hold: "Do not send yet; the reply is still forming or the user may send more. Reconsider shortly.",
      nudge:
        "Send a short follow-up because your own earlier message is still unanswered and you want to prompt them.",
      wait_for_user: "Stay silent and wait for the user's next message.",
      initiate:
        "Send a spontaneous check-in only if no user message is pending and it feels natural.",
    },
  },
  meaningfulAbsence: {
    type: "boolean",
    instructions:
      "Has elapsed time created a genuinely new, unmet interpersonal expectation? Consider this person's own response habits, promises, the other person's circumstances, and service outages. Five more minutes alone is usually not new evidence.",
  },
  unitEnded: {
    type: "boolean",
    instructions:
      "Has this exchange reached a natural resting point, so that whatever is said next should begin a fresh unit of conversation? A burst of messages still awaiting a reply has not ended.",
  },
  ...Object.fromEntries(
    Object.entries(axes).map(([key, instructions]) => [
      key,
      { type: "choice", instructions, criteria },
    ]),
  ),
} as const;

export type Action = keyof typeof questions.action.criteria;
export type Trigger = "input" | "tick";
export type Step = keyof typeof criteria;
type Axis = keyof typeof axes;
export type Judgment = {
  action: Action;
  probabilities: Partial<Record<Action, number>>;
  shifts: Partial<Record<Axis, Step>>;
  meaningfulAbsence: boolean;
  unitEnded: boolean;
  stage: Stage;
};
type JudgeContext = {
  session: Session;
  at: number;
  trigger: Trigger;
  pending: Event[];
  lastSentAt: number | null;
  lastInputAt: number | null;
  previous: { at: number; applied: string[] }[];
  serviceBlocked: boolean;
};
export type Judge = (context: JudgeContext) => Promise<Judgment>;

type ChoiceAnswer = { choice: string; probabilities?: Partial<Record<Action, number>> };
type BooleanAnswer = { probability: number };
type Answers = Record<string, ChoiceAnswer | BooleanAnswer>;

const probability = (answers: Answers, key: string): number => {
  const answer = answers[key];
  if (
    !answer ||
    !("probability" in answer) ||
    !Number.isFinite(answer.probability) ||
    answer.probability < 0 ||
    answer.probability > 1
  )
    throw new Error("Invalid Jev judgment");
  return answer.probability;
};

export const createJudge =
  (evaluate: (state: string, asked: typeof questions) => Promise<Answers>): Judge =>
  async (context) => {
    const answer = await evaluate(
      JSON.stringify({
        persona: context.session.definition,
        stage: context.session.stage,
        stageGuidance: stageGuidance[context.session.stage],
        condition: context.session.condition,
        mutable: context.session.mutable,
        relationship: context.session.relationship,
        traits: context.session.traits,
        recentEvents: context.session.events.slice(-40),
        pending: context.pending.map((event) => event.text),
        lastSentAt: context.lastSentAt,
        lastInputAt: context.lastInputAt,
        previous: context.previous.slice(-3),
        serviceBlocked: context.serviceBlocked,
        now: context.at,
        trigger: context.trigger,
      }),
      questions,
    );
    const chosen = answer["action"];
    const action = (["send_now", "hold", "nudge", "wait_for_user", "initiate"] as const).find(
      (candidate) => chosen && "choice" in chosen && candidate === chosen.choice,
    );
    if (!chosen || !action) throw new Error("Invalid Jev judgment");
    const absence = probability(answer, "meaningfulAbsence");
    const ended = probability(answer, "unitEnded");
    const stageAnswer = answer["stage"];
    const stage = STAGES.find(
      (candidate) => stageAnswer && "choice" in stageAnswer && candidate === stageAnswer.choice,
    );
    if (!stage) throw new Error("Invalid Jev stage");
    const shifts: Record<string, Step> = {};
    for (const field of Object.keys(axes)) {
      const selected = answer[field];
      const step = (
        ["fall_clear", "fall_slight", "stable", "rise_slight", "rise_clear"] as const
      ).find((candidate) => selected && "choice" in selected && candidate === selected.choice);
      if (!step) throw new Error(`Invalid Jev shift: ${field}`);
      shifts[field] = step;
    }
    return {
      action,
      probabilities: "probabilities" in chosen ? (chosen.probabilities ?? {}) : {},
      shifts,
      meaningfulAbsence: absence >= 0.8,
      unitEnded: ended >= 0.8,
      stage,
    };
  };
