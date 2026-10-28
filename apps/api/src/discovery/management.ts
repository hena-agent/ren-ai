import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Effect, Result, Schema } from "effect";
import {
  InvitationSettings,
  InvitationGrant,
  InvitationLookup,
  InvitationCreate,
  SelectContacts,
  StartContact,
} from "@ren-ai/onboarding";
import type { contacts } from "./contacts.ts";
import { contactCause, contactLog } from "./diagnostics.ts";
import type { ContactLog, ContactDiagnostic } from "./diagnostics.ts";
import { SelectionConflict } from "./selection.ts";

const digest = (text: string) => createHash("sha256").update(text).digest();
const parentTrace = (request: Request) => {
  const parent = request.headers.get("x-operation-id");
  return parent && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(parent)
    ? { operationId: parent }
    : {};
};
type InvitationCommit = <I, A extends object, E extends Error>(
  name: "invitations" | "invitation_grant" | "invitation_lookup" | "invitation_create",
  schema: Schema.Decoder<I>,
  run: (input: I) => Effect.Effect<A | null, E>,
) => Promise<Response>;

function invitationRequest(
  path: string,
  store: Effect.Success<ReturnType<typeof contacts>>,
  requestId: string,
  commit: InvitationCommit,
) {
  if (path === "/management/discovery/invitations")
    return commit("invitations", InvitationSettings, (input) =>
      store.configureInvitations(input.enabled).pipe(Effect.as(input)),
    );
  if (path === "/management/discovery/invitations/grant")
    return commit("invitation_grant", InvitationGrant, (input) =>
      store.grantInvitations(input, requestId),
    );
  if (path === "/management/discovery/invitations/lookup")
    return commit("invitation_lookup", InvitationLookup, (input) =>
      store.invitationAccount(input.handle),
    );
  if (path === "/management/discovery/invitations/create")
    return commit("invitation_create", InvitationCreate, store.createInvitation);
  return undefined;
}
const manageContacts = async (
  store: Effect.Success<ReturnType<typeof contacts>>,
  token: string,
  log: ContactLog,
  request: Request,
) => {
  const requestId = randomUUID();
  const started = performance.now();
  const operation = "discovery.management";
  const trace = parentTrace(request);
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
    name:
      | "selection"
      | "start"
      | "invitations"
      | "invitation_grant"
      | "invitation_lookup"
      | "invitation_create",
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
    if (Result.isFailure(result))
      return failure(
        `${name}_failed`,
        result.failure instanceof SelectionConflict ? 409 : 503,
        result.failure,
      );
    return result.success ? respond(result.success, 200) : failure(`${name}_unavailable`, 409);
  };
  if (
    !token ||
    !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${token}`))
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
  const invitation = invitationRequest(path, store, requestId, commit);
  if (invitation) return invitation;
  if (path === "/management/discovery/select")
    return commit("selection", SelectContacts, (input) => store.select(input, requestId));
  if (
    path === "/management/discovery/select-specific" ||
    path === "/management/discovery/select-assigned"
  )
    return commit(
      "selection",
      Schema.Struct({
        ...SelectContacts.fields,
        registrationIDs: Schema.requiredKey(SelectContacts.fields.registrationIDs),
        ...(path.endsWith("select-assigned") && {
          assignments: Schema.requiredKey(SelectContacts.fields.assignments),
        }),
      }),
      (input) => store.select(input, requestId),
    );
  if (path === "/management/discovery/start")
    return commit("start", StartContact, (input) => store.start(input, requestId));
  return failure("not_found", 404);
};

export const contactManagement =
  (
    store: Effect.Success<ReturnType<typeof contacts>>,
    token: string,
    log: ContactLog = contactLog,
  ) =>
  (request: Request) =>
    manageContacts(store, token, log, request);
