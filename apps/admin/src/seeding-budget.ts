import { AsyncLocalStorage } from "node:async_hooks";
import { PersonaError } from "@ren-ai/personas";

const allowance = new AsyncLocalStorage<(micros: number) => Promise<void>>();
export interface SeedingModels {
  text: string;
  image: string;
}
export const pricedSeedingModels: SeedingModels = {
  text: "gemini-3.8-flash",
  image: "gemini-3.1-flash-image",
};
export const withSeedingBudget = <T>(
  reserve: (micros: number) => Promise<void>,
  run: () => Promise<T>,
) => allowance.run(reserve, run);
export const seedingBudgetActive = () => Boolean(allowance.getStore());

/** Reserve a conservative maximum before dispatch, even if the response is lost.
 * UTF-8 bytes bound text tokens; each reference gets 16K input tokens of headroom.
 * Charge all output tokens at the highest rate (image tokens for image models).
 * Do not refund failed/uncertain calls or rely on estimated average persona cost.
 */
export async function reserveGeneration(model: string, input: string, references: number) {
  const reserve = allowance.getStore();
  if (!reserve) return;
  if (!["gemini-3.8-flash", "gemini-3.1-flash-image"].includes(model))
    throw new PersonaError("invalid", "Seeding requires priced default Gemini models");
  const text = model === "gemini-3.8-flash";
  const tokens = new TextEncoder().encode(input).byteLength + references * 16384 + 4096;
  // USD micro-units: use the higher announced 2027 Flash text prices, not the 2026 promotion.
  await reserve(Math.ceil(tokens * (text ? 1.5 : 0.5) + 8192 * (text ? 7.5 : 60)));
}
