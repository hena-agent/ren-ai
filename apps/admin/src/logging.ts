import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface LogFields {
  stage?: string;
  intent?: string;
  personaId?: string;
  style?: string;
  poseIndex?: number;
  model?: string;
  status?: number;
  code?: string;
  providerStatus?: string;
  finishReason?: string;
  blockReason?: string;
  causeName?: string;
  causeCode?: string;
  durationMs?: number;
  jobId?: string;
  imageOrdinal?: number;
  outcome?: "completed" | "failed";
}
export interface LogEntry extends LogFields {
  time: string;
  service: "admin";
  level: "info" | "warn" | "error";
  event: string;
  requestId?: string;
  method?: string;
  route?: string;
  error?: { name: string; message: string; stack: string };
}
export type Log = (entry: LogEntry) => void;
const writeLog: Log = (entry) => {
  const output = entry.level === "info" ? process.stdout : process.stderr;
  output.write(`${JSON.stringify(entry)}\n`);
};
const scope = new AsyncLocalStorage<{
  requestId: string;
  method: string;
  route: string;
  fields: LogFields;
  secrets: string[];
  reported: Map<Error | string, Set<string | undefined>>;
  log: Log;
}>();

export class GenerationError extends Error {
  constructor(
    message: string,
    readonly fields: LogFields,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export function protect(...secrets: string[]) {
  scope.getStore()?.secrets.push(...secrets);
}

export function requestFields(fields: LogFields) {
  const context = scope.getStore();
  if (context) Object.assign(context.fields, fields);
}

export function safeText(text: string, secrets: readonly string[] = []) {
  const protectedValues = [...secrets, ...(scope.getStore()?.secrets ?? [])];
  for (const secret of protectedValues
    .flatMap((value) => [value, ...value.split("\n")])
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length))
    text = text.split(secret).join("<REDACTED>");
  return text.slice(0, 1000);
}

function emit(entry: Omit<LogEntry, "time" | "service">) {
  const context = scope.getStore();
  (context?.log ?? writeLog)({
    time: new Date().toISOString(),
    service: "admin",
    ...(context && {
      requestId: context.requestId,
      method: context.method,
      route: context.route,
      ...context.fields,
    }),
    ...entry,
  });
}

export function reportFailure(
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow caught request, provider and filesystem exceptions for diagnostics
  cause: unknown,
  fields: LogFields,
  level: "warn" | "error" = "error",
) {
  const error = cause instanceof Error ? cause : new Error("Non-Error failure");
  const root = error.cause instanceof Error ? error.cause : error;
  const reported = scope.getStore()?.reported;
  const coordinate = { ...scope.getStore()?.fields, ...fields };
  const style = coordinate.jobId
    ? JSON.stringify([coordinate.jobId, coordinate.imageOrdinal, coordinate.style])
    : fields.style;
  const identity = coordinate.jobId ? style! : error;
  const styles = reported?.get(identity);
  if (styles && (fields.stage === "request" || styles.has(style))) return;
  if (styles) styles.add(style);
  else reported?.set(identity, new Set([style]));
  emit({
    ...fields,
    ...(error instanceof GenerationError && error.fields),
    ...("code" in root && typeof root.code === "string" && { code: root.code }),
    level,
    event: "operation.failed",
    error: {
      name: safeText(root.name),
      message: safeText(root.message),
      // Schema errors can embed whole inputs; stack frames retain call sites without that payload.
      stack: root.stack
        ? safeText(
            root.stack
              .split("\n")
              .filter((line) => /^\s+at /.test(line))
              .join("\n"),
          )
        : "",
    },
  });
}

export async function operation<T>(stage: string, fields: LogFields, run: () => Promise<T>) {
  const start = performance.now();
  emit({ ...fields, stage, level: "info", event: "operation.started" });
  try {
    const context = scope.getStore();
    const result = await (context
      ? scope.run({ ...context, fields: { ...context.fields, ...fields } }, run)
      : run());
    emit({
      ...fields,
      stage,
      level: "info",
      event: "operation.completed",
      durationMs: performance.now() - start,
    });
    return result;
  } catch (error) {
    reportFailure(error, { ...fields, stage, durationMs: performance.now() - start });
    throw error;
  }
}

export function loggedRequest(request: Request, run: () => Promise<Response>, log: Log = writeLog) {
  const path = new URL(request.url).pathname;
  const route = /^\/personas\/[a-zA-Z0-9_-]+$/.test(path)
    ? "/personas/:id"
    : ["/", "/new", "/personas", "/api/personas"].includes(path)
      ? path
      : "/other";
  return scope.run(
    {
      requestId: randomUUID(),
      method: request.method,
      route,
      fields: {},
      secrets: [],
      reported: new Map(),
      log,
    },
    async () => {
      const start = performance.now();
      emit({ level: "info", event: "request.started" });
      const response = await run();
      const requestId = scope.getStore()!.requestId;
      response.headers.set("X-Request-ID", requestId);
      emit({
        level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
        event: "request.completed",
        status: response.status,
        durationMs: performance.now() - start,
      });
      return response;
    },
  );
}

export const requestId = () => scope.getStore()!.requestId;
export const captureLogging = () => AsyncLocalStorage.snapshot();

export function reportQueueCompleted(fields: LogFields & { status: number }) {
  emit({
    ...fields,
    stage: "image.queue",
    event: "image.queue.completed",
    level: fields.status >= 500 ? "error" : fields.status >= 400 ? "warn" : "info",
  });
}
