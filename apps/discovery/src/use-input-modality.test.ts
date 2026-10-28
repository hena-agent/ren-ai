import { fireEvent, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useInputModality } from "./use-input-modality.ts";

const input = () => document.documentElement.getAttribute("data-input");

test("the page records whether the keyboard or a pointer was used last, and forgets both on unmount", () => {
  const view = renderHook(() => useInputModality());
  expect(input()).toBeNull();
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(input()).toBe("keyboard");
  fireEvent.pointerDown(document.body);
  expect(input()).toBe("pointer");
  view.unmount();
  expect(input()).toBeNull();
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(input()).toBeNull();
});
