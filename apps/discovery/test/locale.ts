import { beforeEach, vi } from "vitest";

// Existing interaction scenarios explicitly exercise the Korean interface.
beforeEach(() => vi.spyOn(navigator, "languages", "get").mockReturnValue(["ko-KR"]));
