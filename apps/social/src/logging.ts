export type SocialLogEvent = {
  requestId: string;
  operationId?: string;
  operation: string;
  stage: string;
  outcome: string;
  durationMs: number;
  level: "info" | "warn" | "error";
  code?: string;
  causeName?: string;
  causeCode?: string;
  upstreamStatus?: number;
  stack?: string;
  personaId?: string;
  model?: string;
  status?: number;
  port?: number;
};
export const socialLog = (event: SocialLogEvent) => {
  (event.level === "info" ? process.stdout : process.stderr).write(`${JSON.stringify(event)}\n`);
};
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: allowlist browser, vault and transport failure diagnostics without private payloads
export function socialDiagnostic(cause: unknown) {
  const error = cause instanceof Error ? cause : new Error("Non-Error failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const code =
    "code" in root && typeof root.code === "string" && /^[A-Z0-9_]{1,80}$/.test(root.code)
      ? root.code
      : undefined;
  return {
    causeName: root.constructor.name,
    ...(code && { causeCode: code }),
    ...("upstreamStatus" in root &&
      typeof root.upstreamStatus === "number" && { upstreamStatus: root.upstreamStatus }),
    stack: (root.stack ?? "")
      .split("\n")
      .filter((line) => /^\s+at .*\.(?:ts|js|mjs):\d+:\d+/.test(line))
      .join("\n")
      .slice(0, 4000),
  };
}
