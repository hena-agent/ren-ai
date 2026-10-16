import { buildRevision, parseHealth } from "@ren-ai/transport/health";

export type ExecutorHealth = {
  diskNearlyFull: boolean;
  screenLocked: boolean;
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate untrusted executor health identity and Mac facts
function facts(input: unknown): ExecutorHealth {
  const health = parseHealth(input, "api-msg", buildRevision());
  if (
    health.status !== "ready" ||
    typeof input !== "object" ||
    input === null ||
    !("diskNearlyFull" in input) ||
    typeof input.diskNearlyFull !== "boolean" ||
    !("screenLocked" in input) ||
    typeof input.screenLocked !== "boolean"
  )
    throw new Error("api-msg health response was invalid");
  return { diskNearlyFull: input.diskNearlyFull, screenLocked: input.screenLocked };
}

export const probeExecutor = async (
  url: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<ExecutorHealth> => {
  const response = await fetcher(new URL("/health", url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4_000),
    redirect: "manual",
  }).catch(() => {
    throw new Error("api-msg health request failed");
  });
  if (!response.ok) throw new Error(`api-msg health returned ${response.status}`);
  try {
    return facts(await response.json());
  } catch {
    throw new Error("api-msg health response was invalid");
  }
};
