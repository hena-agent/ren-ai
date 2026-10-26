import { createAdmin } from "../src/admin.ts";
import type { AdminSnapshot } from "../src/admin-state.ts";
import type { ProfileGenerator } from "../src/generation.ts";
import type { LogEntry } from "../src/logging.ts";
import { cloudflareFixture } from "./cloudflare-fixture.ts";
import { generator, fixtureStores } from "./fixtures.ts";

export async function durableFixture(model: ProfileGenerator = generator) {
  const { store } = await cloudflareFixture();
  const state: { saved: AdminSnapshot | undefined; unavailable: boolean } = {
    saved: undefined,
    unavailable: false,
  };
  const logs: LogEntry[] = [];
  const open = () => {
    const admin = createAdmin(store, "test-password", {
      generator: model,
      log: (entry) => logs.push(entry),
      persistence: {
        saved: state.saved,
        checkpoint: async (snapshot) => {
          if (state.unavailable) throw new Error("storage unavailable");
          state.saved = structuredClone(snapshot);
        },
        wake: async () => {},
      },
    });
    fixtureStores.set(admin, store);
    return admin;
  };
  return { store, state, logs, open };
}
