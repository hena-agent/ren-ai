import { Schema } from "effect";

type Profile = { identifier: string; xml: string };
type Http = (url: URL, init: RequestInit) => Promise<Response>;
const profilesPath = "/api/v1/fleet/configuration_profiles";
const enrollSecretsSchema = Schema.Struct({
  spec: Schema.Struct({
    secrets: Schema.NonEmptyArray(
      Schema.Struct({ secret: Schema.NonEmptyString.check(Schema.isTrimmed()) }),
    ),
  }),
});
const pageSchema = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({ identifier: Schema.optional(Schema.String), profile_uuid: Schema.String }),
  ),
  meta: Schema.Struct({ has_next_results: Schema.Boolean }),
});

function endpoint(base: string, token: string): URL {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Fleet URL must be an HTTPS origin without credentials");
  }
  if (!token.trim() || /[\r\n]/.test(token))
    throw new Error("Fleet API token is missing or invalid");
  return new URL(profilesPath, url);
}

function authorization(token: string) {
  return {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error" as const,
    signal: AbortSignal.timeout(30_000),
  };
}

async function enrollmentGet(url: URL, token: string, http: Http): Promise<Response> {
  const response = await http(url, { ...authorization(token), method: "GET" }).catch(() => {
    // The native OTA query carries an enroll secret; never expose transport errors containing it.
    throw new Error("Fleet enrollment request failed");
  });
  if (!response.ok) throw new Error(`Fleet enrollment download failed (HTTP ${response.status})`);
  return response;
}

/** Free OTA bootstrap, company-owned by default. Preserve the signed CMS bytes verbatim. */
export async function downloadEnrollmentProfile(
  base: string,
  token: string,
  http: Http,
): Promise<ArrayBuffer> {
  const origin = endpoint(base, token);
  const secretsURL = new URL("/api/v1/fleet/spec/enroll_secret", origin);
  const secretsResponse = await enrollmentGet(secretsURL, token, http);
  const secrets = await secretsResponse
    .json()
    .then(Schema.decodeUnknownSync(enrollSecretsSchema))
    .catch(() => {
      throw new Error("Invalid Fleet enroll secrets response");
    });
  const url = new URL("/api/v1/fleet/enrollment_profiles/ota", origin);
  url.searchParams.set("enroll_secret", secrets.spec.secrets[0].secret);
  const response = await enrollmentGet(url, token, http);
  return response.arrayBuffer().catch(() => {
    throw new Error("Fleet enrollment body download failed");
  });
}

async function matchingProfile(
  url: URL,
  profile: Profile,
  request: (url: URL) => Promise<Response>,
): Promise<void> {
  let page = 0;
  for (;;) {
    const list = new URL(url);
    list.searchParams.set("page", String(page));
    list.searchParams.set("per_page", "100");
    const response = await request(list);
    const result = Schema.decodeUnknownSync(pageSchema)(await response.json());
    const found = result.profiles.find((candidate) => candidate.identifier === profile.identifier);
    if (found) {
      const download = new URL(
        `${url.pathname}/${encodeURIComponent(found.profile_uuid)}?alt=media`,
        url,
      );
      if ((await (await request(download)).text()) !== profile.xml)
        throw new Error("Existing Fleet profile content differs; refusing to replace it");
      return;
    }
    if (!result.meta.has_next_results)
      throw new Error("Fleet profile conflict does not match this policy");
    page += 1;
  }
}

/** Free-tier POST only. A conflict is success only after downloading identical policy. */
export async function deliverPermissionProfile(
  base: string,
  token: string,
  profile: Profile,
  http: Http,
): Promise<"created" | "already-present"> {
  const url = endpoint(base, token);
  const form = new FormData();
  form.append(
    "profile",
    new Blob([profile.xml], { type: "application/x-apple-aspen-config" }),
    "messaging.mobileconfig",
  );
  const options = authorization(token);
  const response = await http(url, { ...options, method: "POST", body: form });
  if (response.ok) return "created";
  if (response.status !== 409)
    throw new Error(`Fleet profile upload failed (HTTP ${response.status})`);
  await matchingProfile(url, profile, async (target) => {
    const result = await http(target, { ...options, method: "GET" });
    if (!result.ok) throw new Error(`Fleet profile lookup failed (HTTP ${result.status})`);
    return result;
  });
  return "already-present";
}
