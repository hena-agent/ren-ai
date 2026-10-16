import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ProfileDetails } from "./profile-details.tsx";
afterEach(cleanup);
const persona = {
  id: "harin",
  name: "하린",
  bio: "천천히 알아가요.",
  imageUrl: "https://example.net/a.jpg",
};
const fields = {
  image: 0,
  onImageChange: vi.fn<(image: number) => void>(),
  onClose: vi.fn<() => void>(),
  disabled: false,
};

test("JSON sections render as semantic facts, interest chips and question cards in authored order", () => {
  const view = render(
    <ProfileDetails
      {...fields}
      persona={{
        ...persona,
        profile: {
          introduction: "안녕하세요.",
          sections: [
            {
              type: "basics",
              title: "기본 정보",
              items: [{ key: "occupation", label: "직업", value: "도예가" }],
            },
            { type: "interests", title: "관심사", items: ["재즈", "산책"] },
            { type: "lifestyle", title: "라이프스타일", items: [{ label: "주말", value: "산책" }] },
            {
              type: "relationship",
              title: "관계 스타일",
              items: [{ label: "연락", value: "천천히" }],
            },
            { type: "prompt", question: "완벽한 일요일은?", answer: "책방에 가요." },
            { type: "text", title: "내가 편해지는 순간", body: "말없이 같이 있을 때요." },
          ],
        },
      }}
    />,
  );
  expect(screen.getByText("직업").tagName).toBe("DT");
  expect(screen.getByText("도예가").tagName).toBe("DD");
  expect(view.container.querySelectorAll(".profile-interests li")).toHaveLength(2);
  expect(view.container.querySelector(".profile-prompt")?.textContent).toContain("책방에 가요.");
  expect(
    screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
  ).toEqual([
    "기본 정보",
    "관심사",
    "라이프스타일",
    "관계 스타일",
    "완벽한 일요일은?",
    "내가 편해지는 순간",
  ]);
});

test("an introduction-only profile has no placeholder sections and JSON strings stay plain text", () => {
  const view = render(
    <ProfileDetails
      {...fields}
      persona={{
        ...persona,
        profile: {
          introduction: "<script>alert(1)</script>",
          sections: [{ type: "text", title: "내 링크", body: "[책방](javascript:alert(1))" }],
        },
      }}
    />,
  );
  expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
  expect(view.container.querySelector("script, a")).toBeNull();
  view.rerender(
    <ProfileDetails
      {...fields}
      persona={{ ...persona, profile: { introduction: "소개만 있어요.", sections: [] } }}
    />,
  );
  expect(screen.getByText("소개만 있어요.")).toBeTruthy();
  expect(screen.queryByText("관심사")).toBeNull();
});

test("responses from a running older API still show the public bio without a Markdown renderer", () => {
  render(<ProfileDetails {...fields} persona={persona} />);
  expect(screen.getByText(persona.bio)).toBeTruthy();
});
