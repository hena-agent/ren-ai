import { beforeEach, vi } from "vitest";

// Existing interaction scenarios explicitly exercise the Korean interface from a Korean time zone.
beforeEach(() => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["ko-KR"]);
  vi.stubEnv("TZ", "Asia/Seoul");
});
