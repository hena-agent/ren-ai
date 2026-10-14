import { Semaphore } from "effect";

// ponytail: one process-wide mutation lock for admission and resets; partition if admission grows.
const lifecycle = Semaphore.makeUnsafe(1);
export const withLifecycle = lifecycle.withPermits(1);
