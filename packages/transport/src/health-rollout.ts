import { parseHealth, verifyHealth } from "./health.ts";

/** Deployment propagation is bounded; every successful probe still verifies the exact artifact. */
export async function waitForHealth(
  url: string,
  service: string,
  revision: string,
  identityOnly = false,
  fetcher: typeof fetch = fetch,
) {
  for (let attempt = 1; attempt <= 12; attempt++) {
    const started = performance.now();
    let actual: ReturnType<typeof parseHealth> | undefined;
    let status: number | undefined;
    try {
      const response = await fetcher(new URL("/health", url), {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      status = response.status;
      try {
        actual = parseHealth(await response.clone().json(), service);
      } catch {
        /* Untrusted response bodies are never diagnostic output. */
      }
      return await verifyHealth(response, service, revision, identityOnly);
    } catch {
      process.stderr.write(
        JSON.stringify({
          operation: "deployment.health",
          stage: "health.probe",
          level: "warn",
          durationMs: performance.now() - started,
          outcome: "retry",
          attempt,
          expectedService: service,
          expectedRevision: revision,
          ...(status !== undefined && { httpStatus: status }),
          ...(actual && { actualRevision: actual.revision, readiness: actual.status }),
        }) + "\n",
      );
      if (attempt < 12) await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error("Deployment health verification timed out; expected artifact was not confirmed");
}
