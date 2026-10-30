import { Schema } from "effect";
import { SocialAccount, SocialID, SocialStep } from "@ren-ai/onboarding/social";
import { authorize } from "@ren-ai/transport/authorization";
import { applicationRequest } from "../application-request.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { socialStore, type SocialStorage } from "./store.ts";
import { socialService, SocialError, type SocialOptions } from "./service.ts";
import { socialActions } from "./actions.ts";

const RunID = Schema.Struct({ runId: SocialID });
const Completion = Schema.Struct({
  runId: SocialID,
  state: Schema.Literals(["completed", "failed", "login_required"]),
});
const AccountID = Schema.Struct({ accountId: SocialID });
function decode<T>(schema: Schema.Codec<T>, body: string) {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema), { onExcessProperty: "error" })(
      body,
    );
  } catch {
    throw new SocialError(400, "SOCIAL_INPUT_INVALID");
  }
}
function cursor(request: Request) {
  const before = Number(new URL(request.url).searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(before) || before < 1) throw new SocialError(400, "SOCIAL_CURSOR");
  return before;
}

export function createSocial(storage: SocialStorage, options: SocialOptions) {
  const store = socialStore(storage);
  const service = socialService(store, options);
  const actions = socialActions(store, service, options);
  const operate = async (body: string, open: boolean) => {
    const id = decode(AccountID, body).accountId;
    const row = store.account(id);
    if (!row) throw new SocialError(404, "SOCIAL_ACCOUNT_NOT_FOUND");
    if (open) await options.open(id);
    else {
      if (row.state === "running" || !store.config(row).enabled)
        throw new SocialError(409, "SOCIAL_NOT_RUNNABLE");
      store.exec("UPDATE social_account SET next_at=? WHERE id=?", options.now(), id);
    }
    return new Response(null, { status: 204 });
  };
  const turn = (body: string) => {
    const controlled = service.control(decode(RunID, body).runId);
    const { run, account } = controlled;
    const row = store.usage(store.account(account.id)!, options.now());
    if (
      store.exec<{ step: number }>(
        "SELECT step FROM social_turn WHERE run_id=? AND step=?",
        run.id,
        run.step,
      ).length
    )
      return Response.json(controlled);
    if (row.turns >= account.dailyTurns) throw new SocialError(409, "SOCIAL_TURN_LIMIT");
    store.transaction(() => {
      store.exec("INSERT INTO social_turn VALUES (?,?)", run.id, run.step);
      store.exec("UPDATE social_account SET turns=turns+1 WHERE id=?", account.id);
    });
    return Response.json(controlled);
  };
  const endpoints: Record<string, (body: string) => Response | Promise<Response>> = {
    accounts: async (body) => {
      await service.configure(decode(SocialAccount, body));
      return Response.json(store.snapshot(Number.MAX_SAFE_INTEGER));
    },
    control: (body) => Response.json(service.control(decode(RunID, body).runId)),
    open: (body) => operate(body, true),
    now: (body) => operate(body, false),
    turn,
    actions: async (body) => Response.json(await actions(decode(SocialStep, body))),
    complete: (body) => {
      const input = decode(Completion, body);
      service.complete(input.runId, input.state);
      return new Response(null, { status: 204 });
    },
  };
  const handle = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/management/social")
      return Response.json(store.snapshot(cursor(request)));
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.text();
    if (body.length > 32000) throw new SocialError(413, "SOCIAL_INPUT_SIZE");
    const endpoint = endpoints[path.slice("/management/social/".length)];
    return endpoint ? endpoint(body) : new Response(null, { status: 404 });
  };
  const fetch = (request: Request) =>
    applicationRequest(request, (incoming) =>
      authorize(async () => {
        try {
          return await handle(incoming);
        } catch (cause) {
          contactLog({
            requestId: incoming.headers.get("X-Operation-ID")!,
            operation: "social.request",
            stage: "social.handle",
            outcome: "failed",
            durationMs: 0,
            level: cause instanceof SocialError ? "warn" : "error",
            ...contactCause(cause),
          });
          return Response.json(
            { error: cause instanceof SocialError ? cause.code : "SOCIAL_UNAVAILABLE" },
            {
              status: cause instanceof SocialError ? cause.status : 503,
            },
          );
        } finally {
          await store.arm();
        }
      }, options.token)(incoming),
    );
  return {
    fetch,
    alarm: async () => {
      try {
        await service.alarm();
      } catch (cause) {
        contactLog({
          requestId: crypto.randomUUID(),
          operation: "social.alarm",
          stage: "social.dispatch",
          outcome: "failed",
          durationMs: 0,
          level: "error",
          ...contactCause(cause),
        });
      } finally {
        await store.arm();
      }
    },
  };
}
