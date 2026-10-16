import { Schema } from "effect";
import { parsePersona } from "@ren-ai/personas";
import { PublicPersona } from "@ren-ai/onboarding";

export interface CatalogConnection {
  url: string;
  token: string;
}
const Snapshot = Schema.Struct({
  revision: Schema.String,
  personas: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      source: Schema.String,
      state: Schema.String,
      memory: Schema.String,
    }),
  ),
});

function runtimePersona(record: (typeof Snapshot.Type.personas)[number]) {
  const persona = parsePersona(record.id, record.source);
  return {
    ...persona,
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
  const request = async (path: string, authenticated = false) => {
    const response = await fetcher(new URL(path, base), {
      ...(authenticated && { headers: { Authorization: `Bearer ${connection.token}` } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (!response.ok)
      throw Object.assign(
        new Error(
          `Catalog request failed (${response.status}; request ${response.headers.get("x-request-id") ?? "unavailable"})`,
        ),
        { code: "CATALOG_REQUEST_FAILED", upstreamStatus: response.status },
      );
    return response;
  };
  return {
    load: async () => {
      const response = await request("/api/catalog", true);
      try {
        const snapshot = Schema.decodeUnknownSync(Snapshot)(await response.json());
        const entries = snapshot.personas.map(
          (record) => [record.id, runtimePersona(record)] as const,
        );
        const personas = new Map(entries);
        if (personas.size !== entries.length) throw new Error("Duplicate persona ID");
        return { revision: snapshot.revision, personas };
      } catch {
        throw new Error("Invalid private Catalog response");
      }
    },
    publicList: async () => {
      const response = await request("/api/personas");
      try {
        const profiles = Schema.decodeUnknownSync(Schema.Array(PublicPersona))(
          await response.json(),
        );
        return profiles;
      } catch {
        throw new Error("Invalid public Catalog response");
      }
    },
  };
}
