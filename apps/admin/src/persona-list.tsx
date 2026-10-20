import type { PersonaPage, PersonaQuery, PersonaRecord } from "@ren-ai/personas";
import { Preview } from "./profile-preview.tsx";
import { personaPageUrl } from "./persona-query.ts";
import copy from "./copy.json";

export type PersonaListing = PersonaPage & { query: PersonaQuery };

function Filters({ query, languages }: PersonaListing) {
  return (
    <form className="catalog-filters" action="/" method="get" aria-label="페르소나 검색 및 필터">
      <label className="catalog-search">
        이름 · ID
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          maxLength={100}
          placeholder="이름 또는 ID 검색"
        />
      </label>
      <label>
        공개 상태
        <select name="published" defaultValue={query.published}>
          <option value="all">전체</option>
          <option value="published">공개</option>
          <option value="private">비공개</option>
        </select>
      </label>
      <label>
        사진 스타일
        <select name="style" defaultValue={query.style}>
          <option value="all">전체</option>
          <option value="photo">실사 보유</option>
          <option value="anime">애니 보유</option>
          <option value="none">사진 없음</option>
        </select>
      </label>
      <label>
        언어
        <select name="language" defaultValue={query.language}>
          <option value="">전체</option>
          {[...new Set([...languages, query.language])].filter(Boolean).map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
      </label>
      <label>
        정렬
        <select name="sort" defaultValue={query.sort}>
          <option value="newest">생성일 최신순</option>
          <option value="oldest">생성일 오래된순</option>
          <option value="updated">최근 수정순</option>
        </select>
      </label>
      <div className="catalog-filter-actions">
        <button type="submit">검색</button>
        <a href="/">조건 초기화</a>
      </div>
    </form>
  );
}

export function PersonaList({
  personas,
  listing,
}: {
  personas: readonly PersonaRecord[];
  listing?: PersonaListing | undefined;
}) {
  const filtered =
    listing &&
    (listing.query.q ||
      listing.query.published !== "all" ||
      listing.query.style !== "all" ||
      listing.query.language);
  return (
    <>
      {listing && (
        <>
          <Filters {...listing} />
          <p className="catalog-result-count">
            검색 결과 <strong>{listing.total}</strong>개
          </p>
        </>
      )}
      {!personas.length ? (
        <div className="empty">
          <p>{filtered ? "검색 결과가 없습니다." : copy.empty}</p>
          {filtered ? <a href="/">조건 초기화</a> : <a href="/new">{copy.start} →</a>}
        </div>
      ) : (
        <div className="persona-grid">
          {personas.map((persona) => (
            <div key={persona.id}>
              <a className="card-link" href={`/personas/${persona.id}`}>
                <Preview persona={persona} />
                <span className="edit-label">{copy.edit}</span>
              </a>
            </div>
          ))}
        </div>
      )}
      {listing && (
        <nav className="catalog-pagination" aria-label="페르소나 목록 페이지">
          {listing.page > 1 ? (
            <a rel="prev" href={personaPageUrl(listing.query, listing.page - 1)}>
              ← 이전
            </a>
          ) : (
            <span aria-disabled="true">← 이전</span>
          )}
          <span>
            {listing.page} / {listing.pages} 페이지
          </span>
          {listing.page < listing.pages ? (
            <a rel="next" href={personaPageUrl(listing.query, listing.page + 1)}>
              다음 →
            </a>
          ) : (
            <span aria-disabled="true">다음 →</span>
          )}
        </nav>
      )}
    </>
  );
}
