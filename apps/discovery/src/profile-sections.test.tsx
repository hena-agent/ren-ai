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
test("dating information renders as typed sections and empty optional sections stay hidden", () => {
  const view = render(
    <ProfileDetails
      {...fields}
      persona={{
        ...persona,
        publicProfile:
          "안녕하세요.\n\n### 기본 정보\n\n- 직업: 도예가\n\n### 관심사\n\n- 재즈\n- 산책\n\n### 문답: 완벽한 일요일은?\n\n책방에 가요.\n\n### 비어 있는 항목",
      }}
    />,
  );
  expect(view.container.querySelector(".profile-facts")?.textContent).toContain("도예가");
  expect(view.container.querySelectorAll(".profile-interests li")).toHaveLength(2);
  expect(screen.getByRole("heading", { name: "완벽한 일요일은?" })).toBeTruthy();
  expect(view.container.querySelector(".profile-answer")?.textContent).toContain("책방에 가요.");
  expect(screen.queryByRole("heading", { name: "비어 있는 항목" })).toBeNull();
});
test("public Markdown supports persona-chosen headings and omits undisclosed interests", () => {
  render(
    <ProfileDetails
      {...fields}
      persona={{
        ...persona,
        publicProfile:
          "천천히 알아가요.\n\n### 내가 편해지는 순간\n말없이 같이 있을 때요.\n\n### 같이 해보고 싶은 일\n- 독립서점 구경\n- 산책",
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "내가 편해지는 순간" })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByText("관심사")).toBeNull();
});
test("old API introductions are still displayed while raw HTML and unsafe links cannot execute", () => {
  const view = render(<ProfileDetails {...fields} persona={persona} />);
  expect(screen.getByText(persona.bio)).toBeTruthy();
  view.rerender(
    <ProfileDetails
      {...fields}
      persona={{
        ...persona,
        publicProfile: "안녕하세요.\n\n<script>alert(1)</script>\n\n[링크](javascript:alert(1))",
      }}
    />,
  );
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.querySelector("a")?.getAttribute("href")).not.toContain("javascript:");
});
test("reference links keep working across public section boundaries", () => {
  render(
    <ProfileDetails
      {...fields}
      persona={{
        ...persona,
        publicProfile:
          "[소개 링크][place]\n\n### 좋아하는 곳\n\n[책방][place]\n\n[place]: https://example.org/bookshop",
      }}
    />,
  );
  expect(screen.getByRole("link", { name: "소개 링크" }).getAttribute("href")).toBe(
    "https://example.org/bookshop",
  );
  expect(screen.getByRole("link", { name: "책방" }).getAttribute("href")).toBe(
    "https://example.org/bookshop",
  );
});
