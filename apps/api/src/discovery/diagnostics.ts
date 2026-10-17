export interface ContactDiagnostic {
  requestId: string;
  operationId?: string;
  operation: string;
  stage: string;
  outcome: "started" | "completed" | "failed";
  durationMs: number;
  level: "info" | "warn" | "error";
  status?: number;
  upstreamStatus?: number;
  code?: string;
  personaId?: string;
  personaVersion?: number;
  sessionId?: string;
  model?: string;
  causeName?: string;
  causeCode?: string;
  stack?: string;
}
export type ContactLog = (event: ContactDiagnostic) => void;
export const contactLog: ContactLog = (event) => {
  (event.level === "info" ? process.stdout : process.stderr).write(`${JSON.stringify(event)}\n`);
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrows a task/request failure into payload-free diagnostics
export function contactCause(cause: unknown) {
  const error = cause instanceof Error ? cause : new Error("Non-Error failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const coded = "code" in root ? root : error;
  const code =
    "code" in coded && typeof coded.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(coded.code)
      ? coded.code
      : undefined;
  return {
    causeName: root.constructor.name,
    ...(code && { causeCode: code }),
    ...("upstreamStatus" in root &&
      typeof root.upstreamStatus === "number" &&
      Number.isInteger(root.upstreamStatus) &&
      root.upstreamStatus >= 100 &&
      root.upstreamStatus <= 599 && { upstreamStatus: root.upstreamStatus }),
    stack: (root.stack ?? "")
      .split("\n")
      .filter((line) => /^\s+at .*(?:\.(?:ts|js|mjs):\d+:\d+|node:.*:\d+:\d+)/.test(line))
      .join("\n")
      .slice(0, 4000),
  };
}
