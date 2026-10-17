import type { Draft } from "./draft.ts";
import type { QueueSnapshot } from "./image-queue.ts";

export interface AdminSnapshot {
  drafts: readonly (readonly [string, Draft])[];
  queue: QueueSnapshot;
}
export interface AdminPersistence {
  saved?: AdminSnapshot | undefined;
  checkpoint: (snapshot: AdminSnapshot) => Promise<void>;
  wake: () => Promise<void>;
  recovery?: () => Promise<Response>;
}
