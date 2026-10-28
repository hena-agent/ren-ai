import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Site } from "./site.tsx";
import { testClient } from "../test/client.ts";
import type { Activity } from "@ren-ai/onboarding";
import { publicPersonas } from "../test/public-personas.ts";
import { choose } from "../test/choose.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

test("a tab preserves its Source on navigation, expires after 30 idle minutes, and never blocks browsing on a failed report", () => {
  const reports: Activity[] = [];
  const client = testClient({
    profiles: async () => [],
    join: async () => ({ status: "waiting" }),
    activity: async (report) => {
      reports.push(report);
      throw new Error("offline");
    },
  });
  vi.spyOn(document, "referrer", "get").mockReturnValue(
    "https://example.org/private/path?secret=1",
  );
  window.history.replaceState(
    null,
    "",
    "/?utm_source=friends&utm_medium=social&utm_campaign=launch",
  );
  const first = render(<Site client={client} />);
  expect(reports).toEqual([
    expect.objectContaining({
      step: "visit",
      source: {
        entry: "home",
        referrer: "example.org",
        source: "friends",
        medium: "social",
        campaign: "launch",
      },
    }),
  ]);
  first.unmount();
  window.history.replaceState(null, "", "/explore");
  const second = render(<Site client={client} />);
  expect(reports.filter((report) => report.step === "visit")).toHaveLength(1);
  expect(reports.find((report) => report.step === "explore")?.source.entry).toBe("home");
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000);
  fireEvent.pointerDown(document);
  expect(reports.filter((report) => report.step === "visit")).toHaveLength(2);
  second.unmount();
});

test("the device opt-out removes its parameter and survives reloads without reporting", () => {
  const activity = vi.fn<(report: Activity) => Promise<void>>(async () => {});
  const client = testClient({
    activity,
    profiles: async () => [],
    join: async () => ({ status: "waiting" }),
  });
  window.history.replaceState(null, "", "/?metrics=off&utm_source=operator");
  const first = render(<Site client={client} />);
  expect(window.location.search).toBe("?utm_source=operator");
  expect(activity).not.toHaveBeenCalled();
  first.unmount();
  render(<Site client={client} />);
  fireEvent.pointerDown(document);
  expect(activity).not.toHaveBeenCalled();
});

test("resuming a shared profile counts its new Visit and visible profile while preserving country within each Visit", async () => {
  const activity = vi.fn<(report: Activity) => Promise<string>>(async (report) =>
    report.step === "visit" ? "KR" : "US",
  );
  const client = testClient({
    activity,
    profiles: async () => publicPersonas,
    join: async () => ({ status: "waiting" }),
  });
  window.history.replaceState(null, "", "/ko/personas/jia?utm_source=friends");
  render(<Site client={client} />);
  await screen.findByRole("region", { name: /백지아/ });
  await act(async () => {});
  expect(activity.mock.calls.filter(([report]) => report.step === "visit")).toHaveLength(1);
  expect(activity.mock.calls[0]![0].source.entry).toBe("profile");
  fireEvent.pointerDown(document);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000);
  fireEvent.keyDown(document, { key: "Shift" });
  await act(async () => {});
  for (const step of ["visit", "profile_seen", "profile_opened"])
    expect(activity.mock.calls.filter(([report]) => report.step === step)).toHaveLength(2);
  choose(true);
  await act(async () => {});
  expect(activity.mock.calls.find(([report]) => report.step === "like")?.[0]).toMatchObject({
    visitCountry: "KR",
    persona: "jia",
  });
});

test("a Reselection entry counts only one first Like while counting each persona Like", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
  const activity = vi.fn<(report: Activity) => Promise<void>>(async () => {});
  window.history.replaceState(null, "", `/ko/explore#reselect=${"a".repeat(64)}`);
  vi.spyOn(document, "referrer", "get").mockReturnValue(window.location.origin + "/private");
  render(
    <Site
      client={testClient({
        activity,
        profiles: async () => publicPersonas,
        join: async () => ({ status: "waiting" }),
      })}
    />,
  );
  await screen.findByRole("heading", { name: /백지아/ });
  choose(true);
  choose(true);
  expect(activity.mock.calls.filter(([report]) => report.step === "first_like")).toHaveLength(1);
  expect(activity.mock.calls.filter(([report]) => report.step === "like")).toHaveLength(2);
  expect(activity.mock.calls[0]![0].source).toMatchObject({ entry: "reselection", referrer: "" });
  expect(activity.mock.calls[0]![0].device).toBe("phone");
});

test("a delayed country response from an expired Visit cannot label the new Visit", async () => {
  let complete!: (country: string) => void;
  const country = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const activity = vi
    .fn<(report: Activity) => Promise<string | void>>()
    .mockImplementationOnce(() => country)
    .mockResolvedValue(undefined);
  const client = testClient({
    activity,
    profiles: async () => [],
    join: async () => ({ status: "waiting" }),
  });
  const home = render(<Site client={client} />);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000);
  fireEvent.scroll(document);
  await act(async () => {
    complete("KR");
  });
  home.unmount();
  window.history.replaceState(null, "", "/explore");
  render(<Site client={client} />);
  expect(
    activity.mock.calls.find(([report]) => report.step === "explore")?.[0].visitCountry,
  ).toBeUndefined();
});

test("blocked tab storage never interrupts the home page or emits malformed activity", () => {
  vi.stubGlobal("sessionStorage", {
    getItem() {
      throw new Error("blocked");
    },
  });
  const activity = vi.fn<(report: Activity) => Promise<void>>(async () => {});
  render(
    <Site
      client={testClient({
        activity,
        profiles: async () => [],
        join: async () => ({ status: "waiting" }),
      })}
    />,
  );
  expect(screen.getAllByText("Ren AI").length).toBeGreaterThan(0);
  expect(activity).not.toHaveBeenCalled();
});

test("a saved photo preference labels a direct Explore Visit before Catalog loading and after idle expiry", async () => {
  localStorage.setItem("ren-ai.discovery.image-style", "photo");
  window.history.replaceState(null, "", "/explore");
  const activity = vi.fn<(report: Activity) => Promise<void>>(async () => {});
  let loaded!: (people: typeof publicPersonas) => void;
  const profiles = new Promise<typeof publicPersonas>((resolve) => {
    loaded = resolve;
  });
  render(
    <Site
      client={testClient({
        activity,
        profiles: () => profiles,
        join: async () => ({ status: "waiting" }),
      })}
    />,
  );
  expect(activity.mock.calls.map(([report]) => [report.step, report.imageStyle])).toEqual([
    ["visit", "photo"],
    ["explore", "photo"],
  ]);
  await act(async () => loaded(publicPersonas));
  await screen.findByRole("heading", { name: /백지아/ });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000);
  fireEvent.pointerDown(document);
  expect(
    activity.mock.calls
      .filter(([report]) => report.step === "visit")
      .map(([report]) => report.imageStyle),
  ).toEqual(["photo", "photo"]);
});
