import type { ProfileGenerator } from "./generation.ts";
import type { Log } from "./logging.ts";
import type { AdminPersistence } from "./admin-state.ts";
import type { ManagementClient } from "./contact-client.ts";

export interface AdminOptions {
  generator?: ProfileGenerator;
  script?: string;
  log?: Log;
  persistence?: AdminPersistence;
  management?: ManagementClient;
  catalogPending?: () => Promise<boolean>;
}
