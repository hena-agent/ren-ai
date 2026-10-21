export interface ServerEvent {
  requestId: string;
  operation: "discovery.public";
  stage: string;
  outcome: "completed" | "failed";
  level: "info" | "warn" | "error";
  durationMs: number;
  status?: number;
  personaId?: string;
  style?: string;
  code?: string;
  causeName?: string;
  causeCode?: string;
  stack?: string;
  upstreamStatus?: number;
}

export function writeServerLog(event: ServerEvent) {
  const line = JSON.stringify({ time: new Date().toISOString(), service: "discovery", ...event });
  const output = event.level === "info" ? process.stdout : process.stderr;
  output.write(`${line}\n`);
}

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow caught upstream and rendering failures without logging payload-bearing messages
export function serverCause(cause: unknown) {
  const error = cause instanceof Error ? cause : new Error("Non-Error failure");
  const root = error.cause instanceof Error ? error.cause : error;
  return {
    causeName: ["TypeError", "SyntaxError", "TimeoutError", "AbortError", "SchemaError"].includes(
      root.name,
    )
      ? root.name
      : "Error",
    ...("code" in root &&
      typeof root.code === "string" &&
      /^[\w.-]{1,80}$/.test(root.code) && { causeCode: root.code }),
    stack: (root.stack ?? "")
      .replace(root.message, "<redacted>")
      .split("\n")
      .filter((line) => /^\s+at /.test(line))
      .join("\n")
      .slice(0, 2000),
  };
}
