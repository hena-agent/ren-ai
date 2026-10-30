import type { SocialTask, SocialRun } from "@ren-ai/onboarding/social";
import type { SocialApplication } from "./client.ts";
import type { SocialModel } from "./model.ts";

export function socialRunner(application: SocialApplication, model: SocialModel) {
  const running = new Map<
    string,
    { task: SocialTask; run: SocialRun; controller: AbortController; done: Promise<void> }
  >();
  const start = (task: SocialTask) => {
    const existing = running.get(task.account.id);
    if (existing) {
      if (existing.task.run.id === task.run.id) return undefined;
      throw new Error("This social account is already running");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, task.run.deadline - Date.now())),
    ]);
    const state = { task, run: task.run, controller, done: Promise.resolve() };
    running.set(task.account.id, state);
    state.done = (async () => {
      let observation =
        "Begin by checking notifications or discovering relevant users. Use inbox to find private conversations to resume.";
      while (!signal.aborted) {
        const controlled = await application.control(task.run.id, true);
        signal.throwIfAborted();
        state.run = controlled.run;
        const decision = await model.decide(
          task,
          controlled.run,
          `Recent activity in this scope: ${controlled.history ?? "[]"}\n${observation}`,
          signal,
        );
        signal.throwIfAborted();
        const result = await application.action(task.run.id, controlled.run.step, decision);
        observation = result.text;
        if (decision.action.kind === "finish") return;
      }
    })().finally(() => {
      running.delete(task.account.id);
    });
    return state.done;
  };
  return {
    start,
    active: (accountId: string, runId: string) => {
      const state = running.get(accountId);
      if (!state || state.task.run.id !== runId || state.controller.signal.aborted)
        throw new Error("Social run is not active");
      return state.controller.signal;
    },
    cancel: async (accountId: string, runId?: string) => {
      const state = running.get(accountId);
      if (!state) return;
      if (runId !== undefined && state.task.run.id !== runId) return;
      state.controller.abort();
      await model.interrupt(state.task, state.run);
      await state.done.catch(() => {});
    },
  };
}
