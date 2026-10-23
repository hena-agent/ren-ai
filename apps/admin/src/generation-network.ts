import { GenerationError, safeText } from "./logging.ts";

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow fetch failures, including their underlying transport cause
export function networkError(cause: unknown, model: string, secrets: readonly string[]) {
  const error = cause instanceof Error ? cause : new Error("Generation network failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const diagnostic = new GenerationError(safeText(root.message, secrets), {
    model,
    code:
      error.name === "TimeoutError"
        ? "timeout"
        : error.name === "AbortError"
          ? "aborted"
          : "network_error",
    causeName: safeText(root.name, secrets),
    ...("code" in root &&
      typeof root.code === "string" && { causeCode: safeText(root.code, secrets) }),
  });
  if (root.stack) diagnostic.stack = root.stack;
  return diagnostic;
}
