import { vi } from "vitest";

export const captureDiagnostics = () => {
  const logs: string[] = [];
  const sinks = [process.stdout, process.stderr].map((sink) =>
    vi.spyOn(sink, "write").mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    }),
  );
  return { logs, restore: () => sinks.forEach((sink) => sink.mockRestore()) };
};
