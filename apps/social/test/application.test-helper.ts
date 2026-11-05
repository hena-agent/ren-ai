import type { SocialTask } from "@ren-ai/onboarding/social";
import type { SocialApplication } from "../src/client.ts";

export const applicationFixture = (task: SocialTask): SocialApplication => ({
  image: async (_run, id) => ({ id, data: "", mime: "image/jpeg" }),
  progress: async () => {},
  control: async () => ({ run: task.run, account: task.account }),
  action: async () => ({ text: "not used" }),
  complete: async () => {},
  authenticated: async () => {},
});
