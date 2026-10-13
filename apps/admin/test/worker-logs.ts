import { vi } from "vitest";

export const captureWorkerLogs = () => ({
  stdout: vi.spyOn(process.stdout, "write").mockReturnValue(true),
  stderr: vi.spyOn(process.stderr, "write").mockReturnValue(true),
});
