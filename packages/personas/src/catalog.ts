import type { D1Database } from "@cloudflare/workers-types";
import { Schema } from "effect";
import { splitPersonaMarkdown } from "./profile.ts";
import { parseInitialState } from "./initial.ts";
import { languageSummary, type PublicLanguages } from "./languages.ts";

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
  publicProfile: string;
  languages?: typeof PublicLanguages.Type;
  portraits: Partial<Record<Style, string>>;
  secondaryPortraits: { style: Style; imageUrl: string }[];
}

/** Only the initial language proficiency is projected; other State and Memory stay private. */
export async function readPublicCatalog(db: Pick<D1Database, "prepare">) {
  const result = await db
    .prepare(`
    SELECT p.id, p.name, p.markdown, p.state, i.style, i.objectKey, i.position
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
      const languages = row.state.trim()
        ? languageSummary(row.markdown, parseInitialState(row.state).languageProficiency)
        : undefined;
      profile = {
        id: row.id,
        name: row.name,
        bio,
        publicProfile: publicMarkdown,
        ...(languages && { languages }),
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
