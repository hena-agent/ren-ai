import { buildRevision, parseHealth } from "@ren-ai/transport/health";

export const checkSocialHealth = async (
  origin: URL,
  token: string,
  fetcher: typeof fetch,
  failure: (error: Error, status: number) => void,
): Promise<boolean> => {
  let status = 0;
  try {
    const response = await fetcher(new URL("/health", origin), {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error("Social health request failed"), {
        code: "SOCIAL_HEALTH_HTTP",
      });
    }
    if (parseHealth(await response.json(), "social", buildRevision()).status !== "ready")
      throw Object.assign(new Error("Social executor is degraded"), {
        code: "SOCIAL_HEALTH_DEGRADED",
      });
    return true;
  } catch (error) {
    failure(error instanceof Error ? error : new Error("UnknownError"), status);
    return false;
  }
};
