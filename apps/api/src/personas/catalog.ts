import { Schema } from "effect";
import { decodeStoredPersona, validatePortrait } from "@ren-ai/personas";
import type { Portrait } from "@ren-ai/personas";
import { PublicPersona } from "@ren-ai/onboarding";
import { RuntimeSheets } from "./runtime-catalog.ts";

export interface CatalogConnection {
  url: string;
  token: string;
}
const Snapshot = Schema.Struct({
  revision: Schema.String,
  personas: Schema.Array(
    Schema.Struct({
      persona: Schema.Unknown,
      state: Schema.String,
      memory: Schema.String,
      sheets: Schema.optional(RuntimeSheets),
    }),
  ),
});

function runtimePersona(record: (typeof Snapshot.Type.personas)[number]) {
  return {
    ...decodeStoredPersona(record.persona),
    sheets: record.sheets ?? {},
    ...(record.state.trim() &&
      record.memory.trim() && { initial: { state: record.state, memory: record.memory } }),
  };
}

export function catalogClient(connection: CatalogConnection, fetcher: typeof fetch = fetch) {
  const base = new URL(connection.url);
  if (
    base.username ||
    base.password ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))
  )
    throw new Error("Catalog URL must use credential-free HTTPS or local HTTP");
  const request = async (path: string, authenticated = false, allowMissing = false) => {
    const response = await fetcher(new URL(path, base), {
      ...(authenticated && { headers: { Authorization: `Bearer ${connection.token}` } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok && !(allowMissing && response.status === 404))
      throw Object.assign(
        new Error(
          `Catalog request failed (${response.status}; request ${response.headers.get("x-request-id") ?? "unavailable"})`,
        ),
        { code: "CATALOG_REQUEST_FAILED", upstreamStatus: response.status },
      );
    return response;
  };
  return {
    sheet: async (personaID: string, style: "anime" | "photo"): Promise<Portrait | undefined> => {
      const query = new URLSearchParams({ id: personaID, style });
      const response = await request(`/api/catalog/sheet?${query.toString()}`, true, true);
      if (response.status === 404) return undefined;
      const mimeType = response.headers.get("content-type");
      if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
        throw new Error("Invalid identity sheet type");
      const bytes = new Uint8Array(await response.arrayBuffer());
      validatePortrait({ bytes, mimeType });
      return { bytes, mimeType };
    },
    load: async () => {
      const response = await request("/api/catalog", true);
      try {
        const snapshot = Schema.decodeUnknownSync(Snapshot)(await response.json());
        const entries = snapshot.personas.map((record) => {
          const persona = runtimePersona(record);
          return [persona.id, persona] as const;
        });
        const personas = new Map(entries);
        if (personas.size !== entries.length) throw new Error("Duplicate persona ID");
        return { revision: snapshot.revision, personas };
      } catch (cause) {
        throw Object.assign(new Error("Invalid private Catalog response", { cause }), {
          code: "CATALOG_INVALID_PRIVATE_RESPONSE",
        });
      }
    },
    publicList: async () => {
      const response = await request("/api/personas");
      try {
        const profiles = Schema.decodeUnknownSync(Schema.Array(PublicPersona))(
          await response.json(),
        );
        return profiles;
      } catch (cause) {
        throw Object.assign(new Error("Invalid public Catalog response", { cause }), {
          code: "CATALOG_INVALID_PUBLIC_RESPONSE",
        });
      }
    },
  };
}
