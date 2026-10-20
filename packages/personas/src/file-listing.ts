import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PersonaRecord } from "./model.ts";
import { personaImages } from "./portraits.ts";
import { historyFor } from "./version-files.ts";
import { personaPage, personaPageSize, type PersonaQuery } from "./listing.ts";

export async function fileListing(
  directory: string,
  records: readonly PersonaRecord[],
  query: PersonaQuery,
) {
  const q = query.q.toLowerCase();
  const filtered = records.filter((record) => {
    const images = personaImages(record);
    return (
      (record.name.toLowerCase().includes(q) || record.id.toLowerCase().includes(q)) &&
      (query.published === "all" || record.published === (query.published === "published")) &&
      (!query.language || record.language === query.language) &&
      (query.style === "all" ||
        (query.style === "none"
          ? images.length === 0
          : images.some((image) => image.style === query.style)))
    );
  });
  const rows = await Promise.all(
    filtered.map(async (record) => {
      const history = await historyFor(directory, record);
      const info = await stat(join(directory, `${record.id}.md`));
      return { record, created: history.at(-1)!.createdAt, updated: info.mtimeMs };
    }),
  );
  rows.sort((a, b) => {
    const delta = query.sort === "updated" ? b.updated - a.updated : b.created - a.created;
    return (query.sort === "oldest" ? -delta : delta) || b.record.id.localeCompare(a.record.id);
  });
  const page = personaPage(rows.length, query.page);
  const offset = (page.page - 1) * personaPageSize;
  return {
    ...page,
    personas: rows.slice(offset, offset + personaPageSize).map(({ record }) => record),
    languages: [...new Set(records.map((record) => record.language))].toSorted(),
  };
}
