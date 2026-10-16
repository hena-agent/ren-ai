import { expect, test } from "vitest";
import { Schema } from "effect";
import { projectPublicProfile } from "./profile-projection.ts";
import { PublicProfile } from "./public-profile.ts";
import { decodePersona } from "./model.ts";
import { withPublicProfile } from "./profile.ts";

const source = `안녕, **천천히** 알아가요. [책방][place]

### 기본 정보
- 나이: 27세
- 직업: 도예가
- 지역: 서울
- MBTI: INFP

### 관심사
- 재즈
- 산책

### 라이프스타일
- 주말: 늦잠: 그리고 산책

### 관계 스타일
- 연락: 짧게 자주

### 문답: 완벽한 일요일은?
책방에 가요.

### 내가 편해지는 순간
말없이 **같이** 있을 때요.

- 커피 마시기
- 산책

### 비어 있는 항목

[place]: https://example.org/bookshop
`;

test("public Markdown becomes ordered, typed plain-text sections with stable basic keys", () => {
  const profile = projectPublicProfile(source);
  expect(profile).toEqual({
    introduction: "안녕, 천천히 알아가요. 책방",
    sections: [
      {
        type: "basics",
        title: "기본 정보",
        items: [
          { key: "age", label: "나이", value: "27세" },
          { key: "occupation", label: "직업", value: "도예가" },
          { key: "location", label: "지역", value: "서울" },
          { label: "MBTI", value: "INFP" },
        ],
      },
      { type: "interests", title: "관심사", items: ["재즈", "산책"] },
      {
        type: "lifestyle",
        title: "라이프스타일",
        items: [{ label: "주말", value: "늦잠: 그리고 산책" }],
      },
      {
        type: "relationship",
        title: "관계 스타일",
        items: [{ label: "연락", value: "짧게 자주" }],
      },
      { type: "prompt", question: "완벽한 일요일은?", answer: "책방에 가요." },
      {
        type: "text",
        title: "내가 편해지는 순간",
        body: "말없이 같이 있을 때요.\n\n• 커피 마시기\n• 산책",
      },
    ],
  });
  expect(Schema.decodeUnknownSync(PublicProfile)(profile)).toEqual(profile);
  expect(projectPublicProfile("소개만 있어요.")).toEqual({
    introduction: "소개만 있어요.",
    sections: [],
  });
});

test("HTML, reference definitions and Markdown formatting never become executable content", () => {
  const profile = projectPublicProfile(
    "안녕.\n\n<script>secret()</script>\n\n### 내 링크\n[책방](javascript:alert(1))\n\n[ref]: https://example.org",
  );
  expect(profile).toEqual({
    introduction: "안녕.",
    sections: [{ type: "text", title: "내 링크", body: "책방" }],
  });
});

test.each([
  "### 관심사\n재즈, 산책",
  "### 관심사\n- 재즈\n  - 산책",
  "### 관심사\n- <img src=x>",
  "### 관심사\n- ![](https://example.org/empty-alt.png)",
  "### 기본 정보\n- 직업",
  "### 기본 정보\n- : 도예가",
  "### 기본 정보\n- 직업:",
  "### 기본 정보\n- 직업: 도예가\n- 직업: 사진가",
  "### 문답:\n답변만 있어요.",
  "### 문답: &nbsp;\n답변만 있어요.",
])("noncanonical source stays readable as an unstructured text section: %s", (section) => {
  expect(projectPublicProfile(`소개.\n\n${section}`).sections[0]?.type).toBe("text");
});

test("existing published source remains parseable and private drafts stay editable", () => {
  const draft = {
    id: "draft",
    name: "초안",
    bio: "",
    imageUrl: "",
    published: false,
    timeZone: "Asia/Seoul",
    language: "ko",
    openingLine: "Hi",
    memory: "Remember",
    prompt: withPublicProfile("private", "소개.\n\n### 기본 정보\n- 직업"),
  };
  expect(decodePersona(draft).published).toBe(false);
  const record = decodePersona({ ...draft, published: true });
  expect(record.published).toBe(true);
  expect(projectPublicProfile(record.publicProfile!)).toEqual({
    introduction: "소개.",
    sections: [{ type: "text", title: "기본 정보", body: "• 직업" }],
  });
});
