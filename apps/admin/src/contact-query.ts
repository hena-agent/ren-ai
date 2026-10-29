import type { ContactEntry } from "@ren-ai/onboarding";

export const contactStates = {
  waiting: "대기 중",
  scheduled: "첫 연락 예약",
  preparing: "대화 준비 중",
  greeting: "첫 인사 처리 중",
  active: "대화 시작",
  failed: "첫 연락 실패",
  review: "결과 확인 필요",
  blocked: "차단·후보 사용 불가",
  unreachable: "연락처 수정 필요",
  ended: "관계 종료",
};
const choices = {
  state: { all: "모든 상태", ...contactStates },
  eligible: { all: "선정 가능 여부 전체", ready: "선정 가능", unavailable: "선정 불가" },
  kind: { all: "일반·테스트 전체", normal: "일반 연락처", test: "테스트 연락처" },
  visibility: { visible: "기본 목록", hidden: "숨긴 기록", all: "숨김 포함 전체" },
  sort: { newest: "최신 등록순", oldest: "오래된 등록순" },
};
export const contactFilterChoices = choices;
export interface ContactQuery {
  search: string;
  state: string;
  eligible: string;
  kind: string;
  visibility: string;
  sort: string;
}
export const contactQuery = (params: URLSearchParams): ContactQuery => {
  const value = (key: keyof typeof choices) => {
    const candidate = params.get(key) ?? "";
    return Object.hasOwn(choices[key], candidate) ? candidate : Object.keys(choices[key])[0]!;
  };
  return {
    search: (params.get("search") ?? "").trim().slice(0, 100),
    state: value("state"),
    eligible: value("eligible"),
    kind: value("kind"),
    visibility: value("visibility"),
    sort: value("sort"),
  };
};

export function filterContacts(
  entries: readonly (typeof ContactEntry.Type)[],
  query: ContactQuery,
  firstContacts: boolean,
) {
  return entries
    .filter((entry) => {
      if (firstContacts && entry.state === "waiting") return false;
      const facets = {
        state: entry.relationshipEnd ? "ended" : entry.state,
        visibility: entry.hidden ? "hidden" : "visible",
        eligible: entry.eligible ? "ready" : "unavailable",
        kind: entry.testHandle ? "test" : "normal",
      };
      return (
        (["state", "visibility", "eligible", "kind"] as const).every(
          (key) => query[key] === "all" || query[key] === facets[key],
        ) && entry.handle.toLowerCase().includes(query.search.toLowerCase())
      );
    })
    .toSorted((a, b) => {
      const order = a.createdAt - b.createdAt || a.id.localeCompare(b.id);
      return query.sort === "oldest" ? order : -order;
    });
}
