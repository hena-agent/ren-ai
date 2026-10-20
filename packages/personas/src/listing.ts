import type { PersonaRecord } from "./model.ts";

export const personaPageSize = 20;

export interface PersonaQuery {
  page: number;
  q: string;
  published: "all" | "published" | "private";
  style: "all" | "photo" | "anime" | "none";
  language: string;
  sort: "newest" | "oldest" | "updated";
}

export interface PersonaPage {
  personas: readonly PersonaRecord[];
  total: number;
  page: number;
  pages: number;
  languages: readonly string[];
}

export function personaPage(total: number, requested: number) {
  const pages = Math.max(1, Math.ceil(total / personaPageSize));
  return { total, pages, page: Math.min(requested, pages) };
}
