import { Socket } from "node:net";
import { expect, test } from "vitest";
import { local } from "../../test/offline.setup.ts";

test("the server test runner blocks external fetch and outbound sockets", async () => {
  expect(local("127.0.0.1")).toBe(true);
  expect(local("example.com")).toBe(false);
  await expect(fetch("https://example.com/")).rejects.toThrow("Offline test: fetch blocked");
  expect(() => new Socket().connect(443, "example.com")).toThrow("Offline test: socket blocked");
  expect(() => new Socket().connect({ host: "example.com", port: 443 })).toThrow(
    "Offline test: socket blocked",
  );
});
