import type { ProfileGenerator } from "./generation.ts";
import type { Log } from "./logging.ts";
import type { AdminPersistence } from "./admin-state.ts";
import type { ManagementClient } from "./contact-client.ts";
import type { SeedingStore } from "./seeding-store.ts";
import type { SeedingModels } from "./seeding-budget.ts";

export interface AdminOptions {
  generator?: ProfileGenerator;
  localImages?: boolean;
  log?: Log;
  persistence?: AdminPersistence;
  management?: ManagementClient;
  catalogPending?: () => Promise<boolean>;
  seeding?: { repository: SeedingStore; models: SeedingModels };
}
