import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { splitPersonaMarkdown } from "./profile.ts";
import { personaImageBase } from "./image-url.ts";
import { parseInitialState } from "./initial.ts";
import { languageSummary, type PublicLanguages } from "./languages.ts";
import { projectPublicProfile } from "./profile-projection.ts";
import type { PublicProfile } from "./public-profile.ts";

const Row = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  markdown: Schema.String,
  state: Schema.String,
  style: Schema.NullOr(Schema.Literals(["anime", "photo"])),
  objectKey: Schema.NullOr(Schema.String),
  position: Schema.NullOr(Schema.Number),
});
type Style = "anime" | "photo";
interface Profile {
  id: string;
  name: string;
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
    SELECT p.id, p.name, v.markdown, p.state, i.style, i.objectKey, i.position
    FROM personas p JOIN persona_versions v ON v.personaId = p.id AND v.version = p.currentVersion
    LEFT JOIN persona_images i ON i.personaId = p.id
    WHERE p.published = 1 ORDER BY p.id, i.position, i.style
  `)
    .all();
  const rows = Schema.decodeUnknownSync(Schema.Array(Row))(result.results);
  const profiles = new Map<string, Profile>();
  for (const row of rows) {
    let profile = profiles.get(row.id);
    if (!profile) {
      const { bio, publicMarkdown } = splitPersonaMarkdown(row.markdown);
      const languages = row.state.trim()
        ? languageSummary(row.markdown, parseInitialState(row.state).languageProficiency)
        : undefined;
      profile = {
        id: row.id,
        name: row.name,
        bio,
        ...(languages && { languages }),
        profile: projectPublicProfile(publicMarkdown),
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
