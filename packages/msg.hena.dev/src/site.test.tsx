import { act, render, screen } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { copy } from "./copy.ts";
import { Home } from "./pages/home.tsx";
import { Privacy } from "./pages/privacy.tsx";
import { getRouter } from "./router.tsx";

it("renders the root document in Korean", async () => {
  const router = getRouter();
  router.update({ history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  expect(html).toContain('<html lang="ko">');
  expect(html).toContain('<meta charSet="utf-8"/>');
});

it("renders the home page's entries on its own", () => {
  render(<Home />);
  expect(screen.getByRole("heading", { name: copy.home.title })).toBeTruthy();
  expect(screen.getByText(copy.home.description)).toBeTruthy();
  expect(screen.getByText(copy.home.status)).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.home.privacyLink })).toHaveProperty(
    "pathname",
    "/privacy",
  );
});

it("renders the privacy placeholder on its own", () => {
  render(<Privacy />);
  expect(screen.getByRole("heading", { name: copy.privacy.title })).toBeTruthy();
  expect(screen.getByText(copy.privacy.placeholder)).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.privacy.homeLink })).toHaveProperty("pathname", "/");
});

it("navigates both routes through the in-memory router", async () => {
  const router = getRouter();
  router.update({ history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(<RouterProvider router={router} />, { container: document });
  expect(await screen.findByRole("heading", { name: copy.home.title })).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.home.privacyLink })).toBeTruthy();
  await act(() => router.navigate({ to: "/privacy" }));
  expect(await screen.findByRole("heading", { name: copy.privacy.title })).toBeTruthy();
  expect(screen.getByRole("link", { name: copy.privacy.homeLink })).toBeTruthy();
});
