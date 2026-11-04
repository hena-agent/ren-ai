import type { SocialAuthentication } from "../src/authentication.ts";

export const serverAuthStub: SocialAuthentication = {
  ensure: async () => {},
  status: async () => ({ state: "not_configured", hasCredentials: false }),
  submit: async () => ({ state: "not_configured", hasCredentials: false }),
};
