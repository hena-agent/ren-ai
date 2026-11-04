import { Schema } from "effect";
import {
  SocialTask,
  SocialBrowserRequest,
  SocialID,
  SocialPlatform,
} from "@ren-ai/onboarding/social";
import { authorize } from "@ren-ai/transport/authorization";
import { healthResponse } from "@ren-ai/transport/health";
import type { SocialApplication } from "./client.ts";
import type { SocialModel } from "./model.ts";
import { socialRunner } from "./runner.ts";
import { LoginRequired, type socialBrowser } from "./browser.ts";
import { SocialAuthRequest } from "@ren-ai/onboarding/social-auth";
import { AuthenticationError, AuthenticationConflict } from "./auth-store.ts";
import type { SocialAuthentication } from "./authentication.ts";
import { socialLog, socialDiagnostic as diagnostic, type SocialLogEvent } from "./logging.ts";
import { SocialDiagnostic, socialFailureCause } from "@ren-ai/onboarding/social-diagnostics";
import { buildRevision } from "@ren-ai/transport/health";
const WithDiagnostic = Schema.Struct({ diagnostic: SocialDiagnostic });

type Trace = Pick<SocialLogEvent, "requestId" | "operationId" | "personaId" | "model">;
async function boundedBody(request: Request, maximum: number) {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    await request.body?.cancel().catch(() => {});
    throw new Error("Social input exceeds limit");
  }
  if (!request.body) return "";
  const source: ReadableStream<Uint8Array> = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(),
  );
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error("Social input exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
const parse = async <T, E>(request: Request, schema: Schema.Codec<T, E>) => {
  const maximum = new URL(request.url).pathname === "/browser" ? 14200000 : 140000;
  const body = await boundedBody(request, maximum);
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
  browser: ReturnType<typeof socialBrowser>;
  authentication: SocialAuthentication;
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
        await options.browser.execute(
          input.run,
          input.account,
          input.action,
          signal,
          guard,
          {
            requestId: trace.requestId,
            progress: (value) => options.application.progress(input.run.id, input.run.step, value),
          },
          input.image,
        ),
      );
    } catch (cause) {
      if (
        Schema.is(WithDiagnostic)(cause) &&
        !(cause instanceof AuthenticationError) &&
        !(cause instanceof LoginRequired)
      ) {
        log({
          ...trace,
          operation: "social.browser",
          stage: cause.diagnostic.stage,
          outcome: "failed",
          durationMs: cause.diagnostic.durationMs,
          level: "error",
          ...diagnostic(cause),
          code: cause.diagnostic.code,
        });
        return Response.json(
          { error: "SOCIAL_BROWSER_FAILED", diagnostic: cause.diagnostic },
          { status: 422 },
        );
      }
      if (cause instanceof AuthenticationError) {
        log({
          ...trace,
          operation: "social.auth",
          stage: "login.required",
          outcome: "failed",
          durationMs: 0,
          level: "warn",
          code: cause.code,
          causeCode: cause.status.reason ?? cause.status.state,
        });
        return Response.json(
          { error: "SOCIAL_AUTH_REQUIRED", status: cause.status },
          { status: 423 },
        );
      }
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
            {
              requestId: task.run.requestId,
              stage: "model",
              submission: "not_attempted",
              code: "SOCIAL_RUN_FAILED",
              at: Date.now(),
              durationMs: performance.now() - started,
              revision: buildRevision(),
              ...socialFailureCause(cause),
            },
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
    if (path === "/auth") {
      const input = await parse(request, SocialAuthRequest);
      trace.personaId = input.account.personaId;
      const result = await options.authentication.submit(
        input.account,
        input.command,
        trace.requestId,
      );
      return Response.json(result, {
        status: ["checking", "logging_in"].includes(result.state) ? 202 : 200,
      });
    }
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
      const input = await parse(
        request,
        Schema.Struct({ accountId: SocialID, platform: SocialPlatform }),
      );
      await options.browser.open(input.accountId, input.platform);
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
          level: cause instanceof AuthenticationConflict ? "warn" : "error",
          ...diagnostic(cause),
          code: cause instanceof AuthenticationConflict ? cause.code : "SOCIAL_EXECUTOR_FAILED",
        });
        response = Response.json(
          {
            error: cause instanceof AuthenticationConflict ? cause.code : "SOCIAL_EXECUTOR_FAILED",
            requestId,
          },
          { status: cause instanceof AuthenticationConflict ? 409 : 503 },
        );
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
