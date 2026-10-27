import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PublicPersona } from "@ren-ai/onboarding";
import { useCatalog } from "./use-catalog.ts";
import type { DiscoveryClient } from "./client.ts";

afterEach(cleanup);
const original = [{ id: "original", name: "Original", bio: "A public profile", imageUrl: "" }];
const latest = [{ ...original[0]!, id: "latest" }];
const browsingClient = (profiles: DiscoveryClient["profiles"]): DiscoveryClient => ({
  activity: async () => {},
  profiles,
  browse: async () => ({ people: original, nextCursor: null }),
  join: async () => ({ status: "waiting" }),
});

test("refresh retains the ready catalog on failure and forwards the private listing token", async () => {
  const profiles = vi
    .fn<DiscoveryClient["profiles"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(latest);
  const client = browsingClient(profiles);
  const view = renderHook(() => useCatalog(client, original, "private-token"));
  await act(async () => {});
  await act(async () => {
    await expect(view.result.current.refresh()).rejects.toThrow("offline");
  });
  expect(view.result.current.catalog).toEqual({ phase: "ready", people: original });
  await act(async () => view.result.current.refresh());
  expect(view.result.current.catalog).toEqual({ phase: "ready", people: latest });
  expect(profiles.mock.lastCall?.[1]).toBe("private-token");
  const signal = profiles.mock.lastCall![0];
  view.unmount();
  expect(signal.aborted).toBe(true);
});

test("overlapping refreshes cannot overwrite the latest catalog with an aborted older answer", async () => {
  let resolve: (people: readonly PublicPersona[]) => void =
    vi.fn<(people: readonly PublicPersona[]) => void>();
  const profiles = vi
    .fn<DiscoveryClient["profiles"]>()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(latest);
  const client = browsingClient(profiles);
  const { result } = renderHook(() => useCatalog(client, original));
  await act(async () => {});
  let first: Promise<void>;
  await act(async () => {
    first = result.current.refresh();
    await result.current.refresh();
    resolve(original);
    await first;
  });
  expect(profiles.mock.calls[0]![0].aborted).toBe(true);
  expect(result.current.catalog).toEqual({ phase: "ready", people: latest });
});
