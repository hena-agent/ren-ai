import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { BrowsePage, PublicPersona } from "@ren-ai/onboarding";
import { App } from "./app.tsx";
import { BrowseExpiredError, type DiscoveryClient } from "./client.ts";
import { LocaleProvider, useLocale } from "./locale.tsx";
import { useCatalog } from "./use-catalog.ts";
import { choose } from "../test/choose.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const people = Array.from({ length: 20 }, (_, i): PublicPersona => ({
  id: `p${i}`,
  name: `Person ${i}`,
  bio: "Public writing",
  imageUrl: "",
}));
const profiles = async (_signal: AbortSignal, _token?: string, ids: readonly string[] = []) =>
  people.filter((p) => ids.includes(p.id));
const join: DiscoveryClient["join"] = async () => ({ status: "waiting" });
const activity: DiscoveryClient["activity"] = async () => {};

test("ten-card pages prefetch at five, preserve the current card and deduplicate repeated candidate IDs", async () => {
  let complete: (page: BrowsePage) => void = vi.fn<(page: BrowsePage) => void>();
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockResolvedValueOnce({ people: people.slice(0, 10), nextCursor: "next" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  render(<App client={{ browse, profiles, join, activity }} />);
  await screen.findByRole("heading", { name: "Person 0" });
  expect(browse).toHaveBeenCalledOnce();
  for (let i = 0; i < 5; i++) choose(false);
  await waitFor(() => expect(browse).toHaveBeenCalledTimes(2));
  expect(browse.mock.calls[1]![0]).toEqual({ locale: "ko", cursor: "next" });
  expect(screen.getByRole("heading", { name: "Person 5" })).toBeTruthy();
  await act(async () => complete({ people: people.slice(9, 19), nextCursor: null }));
  expect(screen.getByRole("heading", { name: "Person 5" })).toBeTruthy();
  for (let i = 5; i < 19; i++) {
    expect(screen.getByRole("heading", { name: `Person ${i}` })).toBeTruthy();
    choose(false);
  }
  expect(screen.getByRole("heading", { name: "오늘의 프로필을 모두 봤어요." })).toBeTruthy();
});

test("a failed continuation retains existing cards and offers retry rather than a false exhausted state", async () => {
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockResolvedValueOnce({ people: people.slice(0, 10), nextCursor: "next" })
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ people: [people[10]!], nextCursor: null });
  render(<App client={{ browse, profiles, join, activity }} />);
  await screen.findByRole("heading", { name: "Person 0" });
  for (let i = 0; i < 5; i++) choose(false);
  await screen.findByRole("button", { name: "다시 불러오기" });
  expect(screen.getByRole("heading", { name: "Person 5" })).toBeTruthy();
  for (let i = 5; i < 10; i++) choose(false);
  expect(screen.queryByRole("heading", { name: "오늘의 프로필을 모두 봤어요." })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await screen.findByRole("heading", { name: "Person 10" });
  expect(browse.mock.calls[2]![0]).toEqual({ locale: "ko", cursor: "next" });
});

test("locale changes abort stale samples and restore only liked IDs even when absent from the new page", async () => {
  localStorage.setItem("ren-ai.discovery.choices", JSON.stringify({ p19: true, p18: false }));
  let complete: (page: BrowsePage) => void = vi.fn<(page: BrowsePage) => void>();
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce({ people: [people[1]!], nextCursor: null });
  const lookup = vi.fn<DiscoveryClient["profiles"]>(profiles);
  const client = { browse, profiles: lookup, join, activity };
  const view = renderHook(() => ({ catalog: useCatalog(client), language: useLocale() }), {
    wrapper: LocaleProvider,
  });
  await waitFor(() => expect(browse).toHaveBeenCalledOnce());
  await act(async () => view.result.current.language.choose("en"));
  expect(browse.mock.calls[0]![1].aborted).toBe(true);
  expect(browse.mock.calls[1]![0]).toEqual({ locale: "en" });
  await act(async () => complete({ people: [people[0]!], nextCursor: "stale" }));
  expect(view.result.current.catalog.catalog).toEqual({
    phase: "ready",
    people: [people[1], people[19]],
  });
  expect(lookup.mock.calls[1]![2]).toEqual(["p19"]);
  expect(localStorage.getItem("ren-ai.discovery.choices")).toBe(
    JSON.stringify({ p19: true, p18: false }),
  );
});

test("expired cursors restart sampling and abandoned continuation failures cannot overwrite a replacement", async () => {
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockResolvedValueOnce({ people: people.slice(0, 10), nextCursor: "expired" })
    .mockRejectedValueOnce(new BrowseExpiredError())
    .mockResolvedValueOnce({ people: [people[10]!], nextCursor: "last" });
  const client: DiscoveryClient = { browse, profiles, join, activity };
  const view = renderHook(() => useCatalog(client));
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  await act(async () => view.result.current.loadMore());
  expect(browse.mock.calls[2]![0]).toEqual({ locale: "ko" });
  expect(view.result.current.catalog).toEqual({ phase: "ready", people: [people[10]] });
  let fail: (error: Error) => void = vi.fn<(error: Error) => void>();
  browse.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  let pending: Promise<void>;
  await act(async () => {
    pending = view.result.current.loadMore();
  });
  view.unmount();
  await act(async () => {
    fail(new Error("offline"));
    await pending;
  });
});

test("initial resampling failures retain a ready view and can be retried without losing the existing selection", async () => {
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ people: [people[1]!], nextCursor: null });
  const client = { browse, profiles, join, activity };
  const initial = [people[0]!];
  const view = renderHook(() => useCatalog(client, initial));
  await waitFor(() => expect(view.result.current.moreFailed).toBe(true));
  expect(view.result.current.catalog.phase).toBe("ready");
  await act(async () => view.result.current.loadMore());
  expect(view.result.current.moreFailed).toBe(false);
});

test("refreshing before initial sampling finishes supersedes it, and redundant or unmounted continuations do nothing", async () => {
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockResolvedValue({ people: people.slice(0, 10), nextCursor: "next" });
  const client: DiscoveryClient = { browse, profiles, join, activity };
  const view = renderHook(() => useCatalog(client));
  void view.result.current.loadMore();
  await act(async () => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  let complete: (page: BrowsePage) => void = vi.fn<(page: BrowsePage) => void>();
  browse.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  let pending: Promise<void>;
  await act(async () => {
    pending = view.result.current.loadMore();
    await view.result.current.loadMore();
  });
  view.unmount();
  await act(async () => {
    complete({ people: [people[10]!], nextCursor: null });
    await pending;
  });
});

test("selection refresh cannot race a continuation and discard candidates after advancing its cursor", async () => {
  let complete: (value: readonly PublicPersona[]) => void =
    vi.fn<(value: readonly PublicPersona[]) => void>();
  const browse = vi
    .fn<DiscoveryClient["browse"]>()
    .mockResolvedValue({ people: people.slice(0, 10), nextCursor: "next" });
  const lookup: DiscoveryClient["profiles"] = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const client = { browse, profiles: lookup, join, activity };
  const view = renderHook(() => useCatalog(client));
  await waitFor(() => expect(view.result.current.hasMore).toBe(true));
  let refresh: Promise<void>;
  await act(async () => {
    refresh = view.result.current.refresh();
    await view.result.current.loadMore();
  });
  expect(browse).toHaveBeenCalledOnce();
  await act(async () => {
    complete(people.slice(0, 10));
    await refresh;
  });
  await act(async () => view.result.current.loadMore());
  expect(browse.mock.calls[1]![0]).toEqual({ locale: "ko", cursor: "next" });
});
