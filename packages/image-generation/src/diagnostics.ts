interface DiagnosticFields {
  model?: string;
  code?: string;
  status?: number;
  providerStatus?: string;
  causeName?: string;
  causeCode?: string;
}

export class ImageGenerationError extends Error {
  constructor(
    message: string,
    readonly fields: DiagnosticFields,
  ) {
    super(message);
    this.name = "ImageGenerationError";
  }
}

export function redactDiagnostic(text: string, secrets: readonly string[]) {
  for (const secret of secrets
    .flatMap((value) => [value, ...value.split("\n")])
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length))
    text = text.split(secret).join("<REDACTED>");
  return text.slice(0, 1000);
}

export function providerFailure(
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow provider fetch and response parsing failures without retaining payload-bearing messages or stack headers
  cause: unknown,
  model: string,
  secrets: readonly string[],
  parsing = false,
) {
  const error = cause instanceof Error ? cause : new Error("Generation network failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const diagnostic = new ImageGenerationError(
    parsing ? "Invalid image response" : redactDiagnostic(root.message, secrets),
    {
      model,
      code: parsing
        ? "invalid_response"
        : error.name === "TimeoutError"
          ? "timeout"
          : error.name === "AbortError"
            ? "aborted"
            : "network_error",
      causeName: redactDiagnostic(root.name, secrets),
      ...("code" in root &&
        typeof root.code === "string" && { causeCode: redactDiagnostic(root.code, secrets) }),
    },
  );
  if (root.stack)
    diagnostic.stack = redactDiagnostic(
      parsing
        ? root.stack
            .split("\n")
            .filter((line) => /^\s+at /.test(line))
            .join("\n")
        : root.stack,
      secrets,
    );
  return diagnostic;
}
