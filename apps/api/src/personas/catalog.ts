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

export function catalogClient(connection: CatalogConnection, fetcher: typeof fetch = fetch) {
  const base = new URL(connection.url);
  if (
    base.username ||
    base.password ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname)))
  )
    throw new Error("Catalog URL must use credential-free HTTPS or local HTTP");
  const imageUrl = (url: string) =>
    url.startsWith("/discovery/images/") ? new URL(url, base).href : url;
  const runtimePersona = (record: (typeof Snapshot.Type.personas)[number]) => {
    const persona = parsePersona(record.id, record.source);
    return {
      ...persona,
      imageUrl: imageUrl(persona.imageUrl),
      ...(persona.portraits && {
        portraits: Object.fromEntries(
          Object.entries(persona.portraits).map(([style, url]) => [style, imageUrl(url)]),
        ),
      }),
      ...(persona.secondaryPortraits && {
        secondaryPortraits: persona.secondaryPortraits.map((photo) => ({
          ...photo,
          imageUrl: imageUrl(photo.imageUrl),
        })),
      }),
      ...(record.state.trim() &&
        record.memory.trim() && { initial: { state: record.state, memory: record.memory } }),
    };
  };
  const request = async (path: string, authenticated = false) => {
    const response = await fetcher(new URL(path, base), {
      ...(authenticated && { headers: { Authorization: `Bearer ${connection.token}` } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Catalog request failed (${response.status}; request ${response.headers.get("x-request-id") ?? "unavailable"})`,
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
        return Schema.decodeUnknownSync(Schema.Array(PublicPersona))(await response.json());
      } catch {
        throw new Error("Invalid public Catalog response");
      }
    },
    publicImage: async (filename: string) => {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/.test(filename))
        return new Response(null, { status: 404 });
      return fetcher(new URL(`/discovery/images/${filename}`, base), {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    },
  };
}
