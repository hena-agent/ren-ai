import type { Persona } from "@ren-ai/personas";

/** Capacity/rate-limit tests need independently available personas. */
export function onboardingPersonas(base: Persona) {
  return new Map([
    [base.id, base] as const,
    ...Array.from({ length: 40 }, (_, index) => {
      const id = `candidate${index}`;
      return [id, { ...base, id, published: true }] as const;
    }),
  ]);
}
