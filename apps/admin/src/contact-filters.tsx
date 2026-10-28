import { contactFilterChoices } from "./contact-query.ts";
import type { ContactView } from "./contact-page.tsx";

const labels = {
  state: "상태",
  eligible: "선정 가능 여부",
  kind: "연락처 종류",
  visibility: "표시 범위",
  sort: "정렬",
};
export function ContactFilters({ view }: { view: ContactView }) {
  return (
    <form
      method="get"
      action={`/${view.tab}`}
      className="catalog-filters contact-filters"
      aria-label="목록 필터"
    >
      <label className="catalog-search">
        연락처 검색
        <input
          type="search"
          name="search"
          placeholder="전화번호 또는 이메일"
          defaultValue={view.query.search}
        />
      </label>
      {(["state", "eligible", "kind", "visibility", "sort"] as const).map((key) => (
        <label key={key}>
          {labels[key]}
          <select name={key} defaultValue={view.query[key]}>
            {Object.entries(contactFilterChoices[key]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="catalog-filter-actions">
        <button type="submit">적용</button>
        <a href={`/${view.tab}`}>초기화</a>
      </div>
    </form>
  );
}
