import { PersonaError, type PersonaQuery } from "@ren-ai/personas";

function assertSingleValues(params: URLSearchParams) {
  for (const key of ["page", "q", "published", "style", "language", "sort"])
    if (params.getAll(key).length > 1)
      throw new PersonaError("invalid", "검색 조건과 페이지 번호를 확인해 주세요.");
}

export function personaQuery(params: URLSearchParams): PersonaQuery {
  assertSingleValues(params);
  const page = Number(params.get("page") ?? "1");
  const q = (params.get("q") ?? "").trim();
  const published = params.get("published") ?? "all";
  const style = params.get("style") ?? "all";
  const language = params.get("language") ?? "";
  const sort = params.get("sort") ?? "newest";
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    q.length > 100 ||
    language.length > 50 ||
    (published !== "all" && published !== "published" && published !== "private") ||
    (style !== "all" && style !== "photo" && style !== "anime" && style !== "none") ||
    (sort !== "newest" && sort !== "oldest" && sort !== "updated")
  )
    throw new PersonaError("invalid", "검색 조건과 페이지 번호를 확인해 주세요.");
  return { page, q, published, style, language, sort };
}

export function personaPageUrl(query: PersonaQuery, page: number) {
  const params = new URLSearchParams({ ...query, page: String(page) });
  return `/?${params}`;
}
