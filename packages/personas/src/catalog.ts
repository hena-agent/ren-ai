import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { splitPersonaMarkdown } from "./profile.ts";

const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  markdown: Schema.String,
  style: Schema.NullOr(Schema.Literals(["anime", "photo"])),
  objectKey: Schema.NullOr(Schema.String),
  position: Schema.NullOr(Schema.Number),
});
type Style = "anime" | "photo";
interface Profile {
  id: string;
  name: string;
  bio: string;
  publicProfile: string;
  portraits: Partial<Record<Style, string>>;
  secondaryPortraits: { style: Style; imageUrl: string }[];
}

/** The same public projection serves Admin and Discovery, without reading State/Memory. */
export async function readPublicCatalog(db: Pick<D1Database, "prepare">) {
  const result = await db
    .prepare(`
    SELECT p.id, p.name, p.markdown, i.style, i.objectKey, i.position
    FROM personas p LEFT JOIN persona_images i ON i.personaId = p.id
    WHERE p.published = 1 ORDER BY p.id, i.position, i.style
  `)
    .all();
  const rows = Schema.decodeUnknownSync(Schema.Array(Row))(result.results);
  const profiles = new Map<string, Profile>();
  for (const row of rows) {
    let profile = profiles.get(row.id);
    if (!profile) {
      const { bio, publicMarkdown } = splitPersonaMarkdown(row.markdown);
      profile = {
        id: row.id,
        name: row.name,
        bio,
        publicProfile: publicMarkdown,
        portraits: {},
        secondaryPortraits: [],
      };
      profiles.set(row.id, profile);
    }
    if (row.style === null) continue;
    const imageUrl = `/discovery/images/${row.objectKey}`;
    if (row.position === 0) profile.portraits[row.style] = imageUrl;
    else profile.secondaryPortraits.push({ style: row.style, imageUrl });
  }
  return [...profiles.values()].map(({ portraits, ...profile }) => ({
    ...profile,
    imageUrl: portraits.photo ?? portraits.anime ?? "",
    ...(Object.keys(portraits).length > 0 && { portraits }),
  }));
}
