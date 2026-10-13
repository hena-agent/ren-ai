export interface ContactDiagnostic {
  requestId: string;
  operationId?: string;
  operation: string;
  stage: string;
  outcome: "started" | "completed" | "failed";
  durationMs: number;
  level: "info" | "warn" | "error";
  status?: number;
  code?: string;
  personaId?: string;
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
  const code =
    "code" in root && typeof root.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(root.code)
      ? root.code
      : undefined;
  return {
    causeName: root.constructor.name,
    ...(code && { causeCode: code }),
    stack: (root.stack ?? "")
      .split("\n")
      .filter((line) => /^\s+at .*(?:\.(?:ts|js|mjs):\d+:\d+|node:.*:\d+:\d+)/.test(line))
      .join("\n")
      .slice(0, 4000),
  };
}
