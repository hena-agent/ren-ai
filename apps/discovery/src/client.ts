import { Option, Schema } from "effect";
import {
  DiscoveryAnswer,
  DiscoveryFailure,
  DiscoveryNotices,
  PublicPersona,
  BrowsePage,
} from "@ren-ai/onboarding";
import type { BrowseQuery, DiscoveryRequest, Activity } from "@ren-ai/onboarding";

declare global {
  interface ImportMetaEnv {
    readonly VITE_DISCOVERY_API_URL?: string;
  }
}
function path(route: string) {
  return (import.meta.env.VITE_DISCOVERY_API_URL ?? "").replace(/\/$/, "") + route;
}

export type DiscoveryClient = {
  activity: (report: Activity) => Promise<string | void>;
  profiles: (
    signal: AbortSignal,
    reselectionToken: string | undefined,
    ids: readonly string[],
  ) => Promise<readonly PublicPersona[]>;
  browse: (
    query: BrowseQuery,
    signal: AbortSignal,
    reselectionToken?: string,
  ) => Promise<BrowsePage>;
  join: (request: DiscoveryRequest) => Promise<DiscoveryAnswer>;
};
export class RegistrationError extends Error {
  constructor(
    readonly code: DiscoveryFailure | "registration",
    readonly requestId?: string,
    readonly retryAt?: number,
  ) {
    super("Registration unavailable");
  }
}
export class BrowseExpiredError extends Error {}

async function registrationError(response: Response) {
  const code = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(DiscoveryFailure))(await response.text()),
    () => "registration" as const,
  );
  const id = response.headers.get("X-Request-ID") ?? "";
  const requestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : undefined;
  const seconds = Number(response.headers.get("Retry-After"));
  const retryAt =
    code === "try_later" && Number.isInteger(seconds) && seconds > 0 && seconds <= 3600
      ? Date.now() + seconds * 1000
      : undefined;
  return new RegistrationError(code, requestId, retryAt);
}

export async function loadDiscoveryNotices() {
  const response = await fetch(path("/discovery/notices"), { cache: "no-store" });
  if (!response.ok) throw await registrationError(response);
  return Schema.decodeUnknownSync(DiscoveryNotices)(await response.json());
}

export const discoveryClient: DiscoveryClient = {
  activity: async (report) => {
    const response = await fetch(path("/discovery/activity"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    });
    if (!response.ok) throw new Error("Activity unavailable");
    return response.headers.get("X-Visit-Country") ?? undefined;
  },
  browse: async (query, signal, reselectionToken) => {
    const response = await (reselectionToken === undefined
      ? fetch(path(`/discovery/personas?${new URLSearchParams(query)}`), {
          signal,
          cache: "no-store",
        })
      : fetch(path("/discovery/reselection/personas"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          body: JSON.stringify({ ...query, reselectionToken }),
          signal,
          cache: "no-store",
        }));
    if (!response.ok) {
      const error = await registrationError(response);
      if (response.status === 400 && query.cursor && error.code === "personas")
        throw new BrowseExpiredError("Browse expired");
      throw new Error("Profiles unavailable");
    }
    return Schema.decodeUnknownSync(BrowsePage)(await response.json());
  },
  profiles: async (signal, reselectionToken, ids) => {
    const people: PublicPersona[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const response = await fetch(path("/discovery/profiles"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: ids.slice(offset, offset + 100),
          ...(reselectionToken !== undefined && { reselectionToken }),
        }),
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Profiles unavailable");
      people.push(...Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await response.json()));
    }
    return people;
  },
  join: async (request) => {
    const response = await fetch(path("/discovery/waitlist"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw await registrationError(response);
    }
    return Schema.decodeUnknownSync(DiscoveryAnswer)(await response.json());
  },
};
