import { Semaphore } from "effect";

// ponytail: one process-wide mutation lock for the ten-user cap; partition if admission grows.
const lifecycle = Semaphore.makeUnsafe(1);
export const withLifecycle = lifecycle.withPermits(1);
