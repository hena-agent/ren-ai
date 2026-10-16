import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import { SelectContacts, StartContact } from "@ren-ai/onboarding";
import type { contacts } from "./contacts.ts";
import { contactCause, contactLog } from "./diagnostics.ts";
import type { ContactLog, ContactDiagnostic } from "./diagnostics.ts";

const digest = (text: string) => createHash("sha256").update(text).digest();
export const contactManagement =
  (
    store: Effect.Success<ReturnType<typeof contacts>>,
    token: string,
    log: ContactLog = contactLog,
  ) =>
  async (request: Request) => {
    const requestId = randomUUID();
    const started = performance.now();
    const operation = "discovery.management";
    const parent = request.headers.get("x-operation-id");
    const trace =
      parent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parent)
        ? { operationId: parent }
        : {};
    let stage = "authorization";
    const respond = (body: object, status: number) => {
      const event: ContactDiagnostic = {
        ...trace,
        requestId,
        operation,
        stage: "request",
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        outcome: "completed",
        durationMs: performance.now() - started,
        status,
      };
      log(event);
      return Response.json(body, {
        status,
        headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
      });
    };
    const failure = (code: string, status: number, cause?: Error) => {
      log({
        ...trace,
        requestId,
        operation,
        stage,
        code,
        status,
        level: status >= 500 ? "error" : "warn",
        outcome: "failed",
        durationMs: performance.now() - started,
        ...(cause && contactCause(cause)),
      });
      return respond({ error: code, requestId }, status);
    };
    /** Selection and test starts commit the same way; a null result is a refused start. */
    const commit = async <I, A extends object, E extends Error>(
      name: "selection" | "start",
      schema: Schema.Decoder<I>,
      run: (input: I) => Effect.Effect<A | null, E>,
    ) => {
      stage = `${name}.input`;
      let input: I;
      try {
        input = Schema.decodeUnknownSync(schema)(await request.json());
      } catch {
        return failure("invalid_request", 400);
      }
      stage = `${name}.commit`;
      const result = await Effect.runPromise(Effect.result(run(input)));
      if (Result.isFailure(result)) return failure(`${name}_failed`, 503, result.failure);
      return result.success ? respond(result.success, 200) : failure(`${name}_unavailable`, 409);
    };
    if (
      !token ||
      !timingSafeEqual(
        digest(request.headers.get("authorization") ?? ""),
        digest(`Bearer ${token}`),
      )
    )
      return failure("unauthorized", 401);
    const path = new URL(request.url).pathname;
    if (path === "/management/discovery" && request.method === "GET") {
      stage = "waitlist.read";
      const result = await Effect.runPromise(Effect.result(store.list));
      return Result.isFailure(result)
        ? failure("unavailable", 503, result.failure)
        : respond(result.success, 200);
    }
    if (request.method !== "POST") return failure("not_found", 404);
    if (path === "/management/discovery/select")
      return commit("selection", SelectContacts, (input) => store.select(input, requestId));
    if (path === "/management/discovery/select-specific")
      return commit(
        "selection",
        Schema.Struct({
          ...SelectContacts.fields,
          registrationIDs: Schema.Array(SelectContacts.fields.requestId).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(100),
            Schema.isUnique(),
          ),
        }),
        (input) => store.select(input, requestId),
      );
    if (path === "/management/discovery/start")
      return commit("start", StartContact, (input) => store.start(input, requestId));
    return failure("not_found", 404);
  };
