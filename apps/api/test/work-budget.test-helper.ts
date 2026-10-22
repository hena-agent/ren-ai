import { Effect } from "effect";
import { claimWork, withWorkBudget } from "../src/work-budget.ts";

/** Enter a worker after an alarm has spent its admission budget. Pending rows must remain untouched. */
export const exhaustedAlarm = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withWorkBudget(
    Effect.forEach(Array.from({ length: 40 }), () => claimWork, { discard: true }).pipe(
      Effect.andThen(effect),
    ),
  );
