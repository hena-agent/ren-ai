import { parseInitialState, languageSummary } from "@ren-ai/personas";
import type { InitialDocuments } from "@ren-ai/personas";
import type { PublicLanguages } from "@ren-ai/personas/languages";

const levels = {
  beginner: "입문",
  conversational: "일상 대화",
  proficient: "능숙",
  fluent: "유창",
};

export function LanguageReadout({
  languages,
}: {
  languages: typeof PublicLanguages.Type | undefined;
}) {
  if (!languages || !Object.keys(languages.proficiency).length)
    return <p>언어 실력이 아직 설정되지 않았습니다.</p>;
  const names = new Intl.DisplayNames("ko", { type: "language" });
  return (
    <ul>
      {Object.entries(languages.proficiency).map(([code, level]) => (
        <li key={code}>
          {names.of(code)} — {languages.native?.includes(code) ? "모국어" : levels[level]}
          {languages.primary === code ? " · 주 사용 언어" : ""}
        </li>
      ))}
    </ul>
  );
}

export function LanguagePanel({
  source,
  documents,
  locked,
}: {
  source: string;
  documents: InitialDocuments;
  locked: boolean;
}) {
  let languages: typeof PublicLanguages.Type | undefined;
  let valid = false;
  try {
    const state = parseInitialState(documents.state);
    languages = languageSummary(source, state.languageProficiency);
    valid = true;
  } catch {
    // The State/Persona editors show the actionable source diagnostics.
  }
  return (
    <section aria-labelledby="language-title" className="language-panel">
      <h3 id="language-title">언어 실력 · 초기값</h3>
      <LanguageReadout languages={languages} />
      <p>
        State 원문의 languageProficiency에서 언어별 실력을 편집합니다. AI 제안은 저장 전
        미리보기이며, 기존 대화에는 적용하지 않습니다.
      </p>
      <code>languageProficiency: {"{ ko: fluent, en: beginner }"}</code>
      <p>
        Persona의 정체성·외형에서 생년월일 다음 줄에 ‘주 사용 언어: ko’, ‘모국어: ko’를 작성할 수
        있습니다. 실력 단계는 beginner · conversational · proficient · fluent입니다.
      </p>
      <button
        type="submit"
        className="secondary"
        name="intent"
        value="languages"
        disabled={locked || !valid}
      >
        언어 실력 제안받기
      </button>
    </section>
  );
}
