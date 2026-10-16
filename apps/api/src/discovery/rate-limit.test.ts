import { expect, test } from "vitest";
import { submissionLimit } from "./rate-limit.ts";

test("rejected retries cannot extend a visitor's window or grow its history", () => {
  const limit = submissionLimit();
  for (let i = 0; i < 5; i++) expect(limit("visitor", 0)).toBe(false);
  for (let i = 0; i < 1000; i++) expect(limit("visitor", 3_599_999)).toBe(true);
  expect(limit("visitor", 3_600_000)).toBe(false);
});

test("IP admission is bounded and expired visitors free capacity", () => {
  const limit = submissionLimit();
  for (let i = 0; i < 10_000; i++) expect(limit(`visitor-${i}`, 0)).toBe(false);
  expect(limit("overflow", 0)).toBe(true);
  expect(limit("visitor-0", 1)).toBe(false);
  expect(limit("overflow", 3_600_000)).toBe(false);
  expect(limit("visitor-0", 3_600_000)).toBe(false);
  expect(limit(undefined, 3_600_001)).toBe(false);
});
