import { nextSocialTime } from "@ren-ai/onboarding/social";
import type { SocialAuthAccount, SocialAuthInput } from "@ren-ai/onboarding/social-auth";
import { SocialError, type SocialOptions, type SocialService } from "./service.ts";
import type { AccountRow, SocialStore } from "./store.ts";

function identity(store: SocialStore, row: AccountRow): SocialAuthAccount {
  const account = store.config(row);
  return {
    id: account.id,
    handle: account.handle,
    personaId: account.personaId,
    generation: row.generation,
  };
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
      if (input.command.kind !== "status") {
        await service.awaitAuthentication(row);
        const current = store.account(row.id)!;
        if (current.config !== row.config || current.generation !== row.generation)
          throw new SocialError(409, "SOCIAL_CONFIGURATION_CHANGED");
      }
      const result = await options.authenticate(account, input.command, requestId);
      const current = store.account(row.id)!;
      if (
        input.command.kind !== "status" &&
        (current.generation !== account.generation || current.config !== row.config)
      )
        throw new SocialError(409, "SOCIAL_CONFIGURATION_CHANGED");
      if (
        input.command.kind !== "status" &&
        result.state === "logging_in" &&
        current.state === "login_required" &&
        current.generation === account.generation
      )
        store.exec("UPDATE social_account SET next_at=? WHERE id=?", options.now() + 30000, row.id);
      if (input.command.kind === "forget") {
        await service.configure({ ...store.config(row), enabled: false });
        store.exec("UPDATE social_account SET state='paused',next_at=NULL WHERE id=?", row.id);
      }
      return result;
    },
    resume: async (account: SocialAuthAccount) => {
      const row = store.account(account.id);
      if (!row || JSON.stringify(identity(store, row)) !== JSON.stringify(account)) return;
      const result = await options.authenticate(account, { kind: "status" });
      const current = store.account(account.id)!;
      if (
        result.state !== "authenticated" ||
        current.generation !== account.generation ||
        current.state !== "login_required"
      )
        return;
      const config = store.config(current);
      store.exec(
        "UPDATE social_account SET state=?,next_at=? WHERE id=?",
        config.enabled ? "scheduled" : "paused",
        config.enabled ? nextSocialTime(config, options.now()) : null,
        account.id,
      );
    },
  };
}
