import { Effect } from "effect";
import { afterEach, expect, test } from "vitest";
import { cleanup, rustpushFixture } from "../../test/bridge.test-helper.ts";

afterEach(cleanup);

test("availability queries normalized phone/email handles without sending or recording messages", () => {
  const f = rustpushFixture();
  f.bridge.answer(
    "availability",
    { available: true },
    { available: false },
    { status: "sent" },
    { stage: "ids_lookup", cause: { code: "lookup_failed" } },
  );
  return f.run(({ messages }) =>
    Effect.gen(function* () {
      expect(yield* messages.availability("+821012345678")).toEqual({ available: true });
      expect(yield* messages.availability("person@example.com")).toEqual({ available: false });
      expect((yield* messages.availability("+821012345678").pipe(Effect.flip)).message).toBe(
        "Invalid availability response",
      );
      expect((yield* messages.availability("+821012345678").pipe(Effect.flip)).cause).toMatchObject(
        { stage: "ids_lookup" },
      );
      expect(
        f.bridge.requests
          .filter((row) => row.method === "availability")
          .map((row) => row.params["to"]),
      ).toEqual([
        "tel:+821012345678",
        "mailto:person@example.com",
        "tel:+821012345678",
        "tel:+821012345678",
      ]);
      expect(f.bridge.requests.some((row) => row.method === "send")).toBe(false);
      expect(yield* messages.after(0)).toEqual([]);
    }),
  );
});
