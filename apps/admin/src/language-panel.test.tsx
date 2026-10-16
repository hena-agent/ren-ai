import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LanguagePanel, LanguageReadout } from "./language-panel.tsx";
import { initialDocs, initialPersona } from "../test/initial.ts";

test("operator readouts distinguish native, primary, learned and unset languages without exposing source", () => {
  const languages = {
    proficiency: { ko: "fluent", en: "conversational", ja: "proficient", fr: "beginner" },
    primary: "en",
    native: ["ko"],
  } as const;
  const markup = renderToStaticMarkup(<LanguageReadout languages={languages} />);
  expect(markup).toContain("한국어 — 모국어");
  expect(markup).toContain("영어 — 일상 대화 · 주 사용 언어");
  expect(markup).toContain("일본어 — 능숙");
  expect(markup).toContain("프랑스어 — 입문");
  expect(
    renderToStaticMarkup(<LanguageReadout languages={{ proficiency: { en: "fluent" } }} />),
  ).toContain("영어 — 유창");
  for (const value of [undefined, { proficiency: {} }])
    expect(renderToStaticMarkup(<LanguageReadout languages={value} />)).toContain("아직 설정되지");
});

test("initial State errors disable language proposals while valid State stays source-editable", () => {
  const props = { source: initialPersona.description, documents: initialDocs, locked: false };
  expect(renderToStaticMarkup(<LanguagePanel {...props} />)).not.toContain('disabled=""');
  expect(renderToStaticMarkup(<LanguagePanel {...props} locked />)).toContain('disabled=""');
  expect(
    renderToStaticMarkup(
      <LanguagePanel {...props} documents={{ ...initialDocs, state: "invalid" }} />,
    ),
  ).toContain('disabled=""');
  const state = initialDocs.state.replace(
    "traits:",
    "languageProficiency: { en: beginner }\ntraits:",
  );
  expect(
    renderToStaticMarkup(<LanguagePanel {...props} documents={{ ...initialDocs, state }} />),
  ).toContain("영어 — 입문");
});
