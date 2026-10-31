import { Schema } from "effect";
import { SocialTask, SocialBrowserRequest, SocialID } from "@ren-ai/onboarding/social";
import { authorize } from "@ren-ai/transport/authorization";
import { healthResponse } from "@ren-ai/transport/health";
import type { SocialApplication } from "./client.ts";
import type { SocialModel } from "./model.ts";
import { socialRunner } from "./runner.ts";
import { LoginRequired, type xBrowser } from "./browser.ts";

type Event = {
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
type Trace = Pick<Event, "requestId" | "operationId" | "personaId" | "model">;
export const socialLog = (event: Event) => {
  (event.level === "info" ? process.stdout : process.stderr).write(`${JSON.stringify(event)}\n`);
};
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow provider, browser and transport failures without copying private payloads
function diagnostic(cause: unknown) {
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
const parse = async <T>(request: Request, schema: Schema.Codec<T>) => {
  const body = await request.text();
  if (body.length > 140000) throw new Error("Social input exceeds limit");
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema), { onExcessProperty: "error" })(
      body,
    );
  } catch {
    throw new Error("Invalid social executor request");
  }
};
export function socialExecutor(options: {
  token: string;
  application: SocialApplication;
  model: SocialModel;
  browser: ReturnType<typeof xBrowser>;
  readiness: () => Promise<{ chromeCanary: boolean; agentBrowser: boolean; openCode: boolean }>;
  log?: typeof socialLog;
}) {
  const runner = socialRunner(options.application, options.model);
  const log = options.log ?? socialLog;
  const browser = async (request: Request, trace: Trace) => {
    const input = await parse(request, SocialBrowserRequest);
    trace.personaId = input.account.personaId;
    const signal = runner.active(input.account.id, input.run.id);
    const guard = async () => {
      const current = await options.application.control(input.run.id);
      if (
        current.run.generation !== input.run.generation ||
        current.account.personaId !== input.account.personaId ||
        current.run.contact !== input.run.contact
      )
        throw new Error("Social assignment changed");
    };
    await guard();
    try {
      return Response.json(
        await options.browser.execute(input.run, input.account, input.action, signal, guard),
      );
    } catch (cause) {
      if (cause instanceof LoginRequired)
        await options.application.complete(input.run.id, "login_required");
      throw cause;
    }
  };
  const observe = (task: SocialTask, done: Promise<void> | undefined, operationId: string) => {
    if (!done) return;
    const started = performance.now();
    const fields = {
      requestId: task.run.requestId,
      operationId,
      personaId: task.account.personaId,
      model: options.model.model,
      operation: "social.run",
    };
    log({ ...fields, stage: "run.execute", outcome: "started", durationMs: 0, level: "info" });
    void done.then(
      () => {
        log({
          ...fields,
          stage: "run.execute",
          outcome: "completed",
          durationMs: performance.now() - started,
          level: "info",
        });
        return undefined;
      },
      async (cause) => {
        log({
          ...fields,
          stage: "run.execute",
          outcome: "failed",
          durationMs: performance.now() - started,
          level: "error",
          ...diagnostic(cause),
        });
        try {
          await options.application.complete(
            task.run.id,
            cause instanceof LoginRequired ? "login_required" : "failed",
          );
        } catch (completionCause) {
          log({
            ...fields,
            operation: "social.callback",
            stage: "run.complete",
            outcome: "failed",
            durationMs: performance.now() - started,
            level: "error",
            code: "SOCIAL_COMPLETION_FAILED",
            ...diagnostic(completionCause),
          });
        }
      },
    );
  };
  const handle = async (request: Request, trace: Trace) => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      const dependencies = await options.readiness();
      return healthResponse(
        "social",
        Object.values(dependencies).every(Boolean) ? "ready" : "degraded",
        dependencies,
      );
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (path === "/runs") {
      const task = await parse(request, SocialTask);
      trace.personaId = task.account.personaId;
      const done = runner.start(task);
      observe(task, done, trace.requestId);
      return new Response(null, { status: 202 });
    }
    if (path === "/cancel") {
      const input = await parse(
        request,
        Schema.Struct({ accountId: SocialID, runId: Schema.optionalKey(SocialID) }),
      );
      await runner.cancel(input.accountId, input.runId);
      return new Response(null, { status: 204 });
    }
    if (path === "/open") {
      await options.browser.open(
        (await parse(request, Schema.Struct({ accountId: SocialID }))).accountId,
      );
      return new Response(null, { status: 204 });
    }
    if (path === "/browser") {
      return browser(request, trace);
    }
    log({
      ...trace,
      operation: "social.request",
      stage: "routing",
      outcome: "failed",
      durationMs: 0,
      level: "warn",
      code: "SOCIAL_NOT_FOUND",
    });
    return new Response(null, { status: 404 });
  };
  return (request: Request) => {
    const requestId = crypto.randomUUID();
    const trace: Trace = { requestId, model: options.model.model };
    const parent = request.headers.get("X-Operation-ID");
    if (parent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parent))
      trace.operationId = parent;
    const started = performance.now();
    return authorize(async () => {
      let response: Response;
      try {
        response = await handle(request, trace);
      } catch (cause) {
        log({
          ...trace,
          operation: "social.request",
          stage: "request.handle",
          outcome: "failed",
          durationMs: performance.now() - started,
          level: "error",
          ...diagnostic(cause),
          code: "SOCIAL_EXECUTOR_FAILED",
        });
        response = Response.json({ error: "SOCIAL_EXECUTOR_FAILED", requestId }, { status: 503 });
      }
      return response;
    }, options.token)(request).then((response) => {
      response.headers.set("X-Request-ID", requestId);
      response.headers.set("Cache-Control", "no-store");
      log({
        ...trace,
        operation: "social.request",
        stage: "request",
        outcome: response.ok ? "completed" : "failed",
        durationMs: performance.now() - started,
        level: response.ok ? "info" : "warn",
        status: response.status,
      });
      return response;
    });
  };
}
