import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { personaImageBase } from "./image-url.ts";
import type { PublicLanguages } from "./languages.ts";
import type { PublicProfile } from "./public-profile.ts";
import { ageOn } from "./birth-date.ts";
import { readProjection } from "./projection.ts";

const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projection: Schema.String,
  style: Schema.NullOr(Schema.Literals(["anime", "photo"])),
  objectKey: Schema.NullOr(Schema.String),
  position: Schema.NullOr(Schema.Number),
});
type Style = "anime" | "photo";
interface Profile {
  id: string;
  name: string;
  age?: number;
  bio: string;
  languages?: typeof PublicLanguages.Type;
  profile: PublicProfile;
  portraits: Partial<Record<Style, string>>;
  secondaryPortraits: { style: Style; imageUrl: string }[];
}

/** Public catalog projection includes direct image URLs and only initial proficiency from State. */
export async function readPublicCatalog(
  db: Pick<D1Database, "prepare">,
  imageBase = personaImageBase,
) {
  const result = await db
    .prepare(`
    SELECT p.id, p.name, p.projection, i.style, i.objectKey, i.position
    FROM personas p LEFT JOIN persona_images i ON i.personaId = p.id
    WHERE p.published = 1 ORDER BY p.id, i.position, i.style
  `)
    .all();
  const rows = Schema.decodeUnknownSync(Schema.Array(Row))(result.results);
  const profiles = new Map<string, Profile>();
  for (const row of rows) {
    let profile = profiles.get(row.id);
    if (!profile) {
      const { bio, public: published } = readProjection(row.projection);
      if (!published) throw new Error(`Published persona ${row.id} has no public projection`);
      profile = {
        id: row.id,
        name: row.name,
        ...(published.birthDate && { age: ageOn(published.birthDate) }),
        bio,
        ...(published.languages && { languages: published.languages }),
        profile: published.profile,
        portraits: {},
        secondaryPortraits: [],
      };
      profiles.set(row.id, profile);
    }
    if (row.style === null) continue;
    const imageUrl = `${imageBase}${row.objectKey}`;
    if (row.position === 0) profile.portraits[row.style] = imageUrl;
    else profile.secondaryPortraits.push({ style: row.style, imageUrl });
  }
  return [...profiles.values()].map(({ portraits, ...profile }) => ({
    ...profile,
    imageUrl: portraits.photo ?? portraits.anime ?? "",
    ...(Object.keys(portraits).length > 0 && { portraits }),
  }));
}
