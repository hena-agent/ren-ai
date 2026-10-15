export type ExecutorHealth = {
  diskNearlyFull: boolean;
  screenLocked: boolean;
};

const healthPattern =
  /^\s*\{\s*"diskNearlyFull"\s*:\s*(true|false)\s*,\s*"screenLocked"\s*:\s*(true|false)\s*\}\s*$/;

export const probeExecutor = async (
  url: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<ExecutorHealth> => {
  const response = await fetcher(new URL("/health", url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4_000),
  }).catch(() => {
    throw new Error("api-msg health request failed");
  });
  if (!response.ok) throw new Error(`api-msg health returned ${response.status}`);
  const body = await response.text().catch(() => "");
  const fields = healthPattern.exec(body);
  if (fields === null) throw new Error("api-msg health response was invalid");
  return { diskNearlyFull: fields[1] === "true", screenLocked: fields[2] === "true" };
};
