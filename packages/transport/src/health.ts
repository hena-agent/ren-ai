interface ServiceHealth {
  service: string;
  revision: string;
  status: "ready" | "degraded";
}

declare const BUILD_REVISION: string;
/** Production bundles embed the source SHA; unbundled local runs identify themselves explicitly. */
export const buildRevision = () =>
  typeof BUILD_REVISION === "undefined" ? "development" : BUILD_REVISION;

export const healthResponse = (
  service: string,
  status: ServiceHealth["status"] = "ready",
  details: object = {},
) =>
  Response.json(
    { ...details, service, revision: buildRevision(), status },
    { status: status === "ready" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate untrusted service-health JSON before using identity or readiness
export function parseHealth(input: unknown, service: string, revision?: string): ServiceHealth {
  if (
    typeof input !== "object" ||
    input === null ||
    !("service" in input) ||
    input.service !== service ||
    !("revision" in input) ||
    typeof input.revision !== "string" ||
    !(input.revision === "development" || /^[0-9a-f]{40}$/.test(input.revision)) ||
    !("status" in input) ||
    (input.status !== "ready" && input.status !== "degraded")
  )
    throw new Error("Unexpected service health response");
  if (revision !== undefined && input.revision !== revision)
    throw new Error("Service revision does not match deployed artifact");
  return { service, revision: input.revision, status: input.status };
}

export async function verifyHealth(
  response: Response,
  service: string,
  revision: string,
  identityOnly = false,
) {
  let input: ServiceHealth;
  try {
    input = parseHealth(await response.json(), service, revision);
  } catch {
    throw new Error("Service identity or revision verification failed");
  }
  if (response.status !== (input.status === "ready" ? 200 : 503))
    throw new Error("Service health HTTP status is inconsistent");
  if (!identityOnly && input.status !== "ready") throw new Error("Service is not ready");
  return input;
}

interface DependencyHealth {
  status:
    | "ready"
    | "degraded"
    | "unauthorized"
    | "unexpected_response"
    | "unreachable"
    | "unconfigured";
  service?: string;
  revision?: string;
}

export async function probeHealth(
  url: string,
  service: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<DependencyHealth> {
  if (!token.trim()) return { status: "unconfigured" };
  let response: Response;
  try {
    response = await fetcher(new URL("/health", url), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    return { status: "unreachable" };
  }
  if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
  if (response.status !== 200 && response.status !== 503) return { status: "unexpected_response" };
  try {
    const result = parseHealth(await response.json(), service);
    if (response.status !== (result.status === "ready" ? 200 : 503))
      return { status: "unexpected_response" };
    return result;
  } catch {
    return { status: "unexpected_response" };
  }
}
