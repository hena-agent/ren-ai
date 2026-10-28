import { beforeEach, vi } from "vitest";

// Existing interaction scenarios explicitly exercise the Korean interface from a Korean time zone.
beforeEach(() => {
  if (typeof window !== "undefined") window.history.replaceState(null, "", "/");
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["ko-KR"]);
  vi.stubEnv("TZ", "Asia/Seoul");
  if (typeof HTMLImageElement !== "undefined")
    vi.spyOn(HTMLImageElement.prototype, "decode").mockReset().mockResolvedValue(undefined);
});
