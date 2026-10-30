import type { SocialAccount, SocialTask } from "./social.ts";

export const socialAccount: SocialAccount = {
  id: "first",
  handle: "persona_x",
  personaId: "alice",
  enabled: false,
  instructions: "Find people who enjoy Character.AI",
  invitation: "SOCIAL20",
  timeZone: "Asia/Seoul",
  startHour: 9,
  endHour: 22,
  intervalMinutes: 30,
  runMinutes: 5,
  dailyTurns: 20,
  dailyWrites: 5,
};
export const socialTask = (): SocialTask => ({
  account: { ...socialAccount, enabled: true },
  snapshot: "{}",
  run: {
    id: "run-1",
    accountId: socialAccount.id,
    generation: 1,
    requestId: "request-1",
    deadline: Date.now() + 60000,
    contact: null,
    step: 0,
  },
});
