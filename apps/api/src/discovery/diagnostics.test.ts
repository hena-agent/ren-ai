import { expect, test } from "vitest";
import { contactOperationId } from "./diagnostics.ts";

test("upstream diagnostic correlation accepts only a real Error's UUID, never private echoed input", () => {
  const id = crypto.randomUUID();
  expect(contactOperationId(Object.assign(new Error("private failure"), { requestId: id }))).toBe(
    id,
  );
  for (const cause of [
    undefined,
    { requestId: id },
    new Error("missing ID"),
    Object.assign(new Error("private"), { requestId: 37 }),
    Object.assign(new Error("private"), { requestId: "private prompt authorization-token" }),
  ])
    expect(contactOperationId(cause)).toBeUndefined();
});
