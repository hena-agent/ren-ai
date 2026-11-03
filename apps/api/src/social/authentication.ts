import type { SocialAuthAccount, SocialAuthInput } from "@ren-ai/onboarding/social-auth";
import { SocialError, type SocialOptions, type SocialService } from "./service.ts";
import type { AccountRow, SocialStore } from "./store.ts";

function identity(store: SocialStore, row: AccountRow): SocialAuthAccount {
  const account = store.config(row);
  return {
    id: account.id,
    platform: account.platform,
    handle: account.handle,
    personaId: account.personaId,
    generation: row.generation,
  };
}
function currentAccount(store: SocialStore, prior: AccountRow) {
  const current = store.account(prior.id)!;
  const discovered =
    !store.config(prior).handle &&
    JSON.stringify({ ...store.config(current), handle: "" }) === prior.config;
  if (current.generation !== prior.generation || (current.config !== prior.config && !discovered))
    throw new SocialError(409, "SOCIAL_CONFIGURATION_CHANGED");
  return current;
}
export function socialAuthentication(
  store: SocialStore,
  service: SocialService,
  options: SocialOptions,
) {
  return {
    request: async (input: typeof SocialAuthInput.Type, requestId: string) => {
      const row = store.account(input.accountId);
      if (!row) throw new SocialError(404, "SOCIAL_ACCOUNT_NOT_FOUND");
      const account = identity(store, row);
      if (input.command.kind !== "status" && input.command.kind !== "check") {
        await service.awaitAuthentication(row);
        currentAccount(store, row);
      }
      const result = await options.authenticate(account, input.command, requestId);
      const current = currentAccount(store, row);
      if (
        input.command.kind !== "status" &&
        ["checking", "logging_in"].includes(result.state) &&
        current.state === "login_required" &&
        current.generation === account.generation
      )
        store.exec("UPDATE social_account SET next_at=? WHERE id=?", options.now() + 30000, row.id);
      if (input.command.kind === "forget") {
        await service.configure({ ...store.config(current), enabled: false });
        store.exec("UPDATE social_account SET state='paused',next_at=NULL WHERE id=?", row.id);
      }
      if (result.state === "authenticated" && !service.confirmAuthentication(current, result))
        return {
          ...result,
          state: "failed" as const,
          reason: result.handle ? ("account_mismatch" as const) : ("unavailable" as const),
        };
      return result;
    },
    resume: async (account: SocialAuthAccount) => {
      const row = store.account(account.id);
      if (!row || JSON.stringify(identity(store, row)) !== JSON.stringify(account)) return;
      const result = await options.authenticate(account, { kind: "status" });
      const current = store.account(account.id)!;
      if (result.state !== "authenticated" || current.generation !== account.generation) return;
      service.confirmAuthentication(current, result);
    },
  };
}
