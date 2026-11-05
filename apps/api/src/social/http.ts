import { Schema } from "effect";
import { SocialAccount, SocialID, SocialStep } from "@ren-ai/onboarding/social";
import { authorize } from "@ren-ai/transport/authorization";
import { applicationRequest } from "../application-request.ts";
import { contactCause, contactLog } from "../discovery/diagnostics.ts";
import { socialStore, type SocialStorage } from "./store.ts";
import { socialService, SocialError, type SocialOptions } from "./service.ts";
import { socialActions } from "./actions.ts";
import { SocialAuthInput, SocialAuthAccount } from "@ren-ai/onboarding/social-auth";
import { socialAuthentication } from "./authentication.ts";
import { macDeployment } from "./deployment.ts";
import { DeploymentClaim, DeploymentReport } from "@ren-ai/transport/deployment";
import { SocialDiagnostic } from "@ren-ai/onboarding/social-diagnostics";
import { saveSocialDiagnostic } from "./diagnostics.ts";
import { socialImages } from "./images.ts";
const Progress = Schema.Struct({
  runId: SocialID,
  step: Schema.Number,
  diagnostic: SocialDiagnostic,
});

const RunID = Schema.Struct({ runId: SocialID });
const Completion = Schema.Struct({
  diagnostic: Schema.optionalKey(SocialDiagnostic),
  runId: SocialID,
  state: Schema.Literals(["completed", "failed", "login_required"]),
});
const AccountID = Schema.Struct({ accountId: SocialID });
function decode<T, E>(schema: Schema.Codec<T, E>, body: string) {
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
async function readBody(request: Request, maximum: number) {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    await request.body?.cancel().catch(() => {});
    throw new SocialError(413, "SOCIAL_INPUT_SIZE");
  }
  if (!request.body) return "";
  const source: ReadableStream<Uint8Array> = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(),
  );
  const reader = source.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new SocialError(413, "SOCIAL_INPUT_SIZE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SocialError(400, "SOCIAL_INPUT_INVALID");
  }
}

export function createSocial(storage: SocialStorage, options: SocialOptions) {
  const store = socialStore(storage);
  const service = socialService(store, options);
  const images = socialImages(store, options.now, options.images);
  const actions = socialActions(store, service, options, images);
  const control = (id: string) => {
    const value = service.control(id);
    return {
      ...value,
      images:
        value.run.contact === null ? images.latest(value.account.id, value.run.generation) : [],
    };
  };
  const authentication = socialAuthentication(store, service, options);
  const deployment = macDeployment(
    store,
    options.now,
    options.gatewayUrl ?? "https://api-msg.renai.im",
  );
  const snapshot = (before: number) => ({
    ...store.snapshot(before),
    deployment: deployment.status(),
    images: images.snapshot(),
    imageSupport: Boolean(options.images),
  });
  const operate = async (body: string, open: boolean) => {
    const id = decode(AccountID, body).accountId;
    const row = store.account(id);
    if (!row) throw new SocialError(404, "SOCIAL_ACCOUNT_NOT_FOUND");
    if (open) await options.open(id, store.config(row).platform);
    else {
      if (["running", "login_required"].includes(row.state) || !store.config(row).enabled)
        throw new SocialError(409, "SOCIAL_NOT_RUNNABLE");
      store.exec("UPDATE social_account SET next_at=? WHERE id=?", options.now(), id);
    }
    return new Response(null, { status: 204 });
  };
  const turn = (body: string) => {
    const controlled = control(decode(RunID, body).runId);
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
  const endpoints: Record<
    string,
    (body: string, requestId: string) => Response | Promise<Response>
  > = {
    "image-preview": async (body) => {
      const input = decode(Schema.Struct({ accountId: SocialID, imageId: SocialID }), body);
      const row = store.account(input.accountId);
      if (!row) throw new SocialError(404, "SOCIAL_ACCOUNT_NOT_FOUND");
      return Response.json(
        await images.operatorPreview(store.config(row), row.generation, input.imageId),
      );
    },
    image: async (body) => {
      const input = decode(Schema.Struct({ runId: SocialID, imageId: SocialID }), body);
      const value = service.control(input.runId);
      return Response.json(await images.preview(value.run, value.account, input.imageId));
    },
    progress: (body) => {
      const input = decode(Progress, body);
      const { run, account } = service.control(input.runId);
      const event = store.exec<{ kind: string }>(
        "SELECT kind FROM social_event WHERE run_id=? AND step=? AND state='pending'",
        run.id,
        input.step,
      )[0];
      if (run.step !== input.step || !event) throw new SocialError(409, "SOCIAL_PROGRESS_STALE");
      store.transaction(() => {
        saveSocialDiagnostic(store, run.id, input.step, input.diagnostic);
        if (
          input.diagnostic.submission === "verified" &&
          input.diagnostic.postId &&
          ["post", "reply"].includes(event.kind) &&
          run.contact === null
        ) {
          const postId = input.diagnostic.postId;
          if (account.platform === "x" && !/^\d+$/.test(postId))
            throw new SocialError(400, "SOCIAL_RECEIPT_ID_INVALID");
          const url =
            account.platform === "threads"
              ? `https://www.threads.com/@${account.handle}/post/${postId}`
              : `https://x.com/${account.handle}/status/${postId}`;
          store.exec(
            "UPDATE social_event SET url=? WHERE run_id=? AND step=? AND state='pending'",
            url,
            run.id,
            input.step,
          );
        }
      });
      return new Response(null, { status: 204 });
    },
    "deployment/request": () => Response.json(deployment.request(), { status: 202 }),
    "deployment/claim": (body) => Response.json(deployment.claim(decode(DeploymentClaim, body))),
    "deployment/report": (body) => Response.json(deployment.report(decode(DeploymentReport, body))),
    auth: async (body, requestId) =>
      Response.json(await authentication.request(decode(SocialAuthInput, body), requestId)),
    authenticated: async (body) => {
      await authentication.resume(decode(SocialAuthAccount, body));
      return new Response(null, { status: 204 });
    },
    accounts: async (body) => {
      await service.configure(decode(SocialAccount, body));
      return Response.json(snapshot(Number.MAX_SAFE_INTEGER));
    },
    control: (body) => Response.json(control(decode(RunID, body).runId)),
    open: (body) => operate(body, true),
    now: (body) => operate(body, false),
    turn,
    actions: async (body) => Response.json(await actions(decode(SocialStep, body))),
    complete: (body) => {
      const input = decode(Completion, body);
      service.complete(input.runId, input.state, input.diagnostic);
      return new Response(null, { status: 204 });
    },
  };
  const handle = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/management/social")
      return Response.json(snapshot(cursor(request)));
    if (request.method === "GET" && path === "/management/social/deployment")
      return Response.json(deployment.snapshot());
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await readBody(request, 32000);
    const endpoint = endpoints[path.slice("/management/social/".length)];
    return endpoint
      ? endpoint(body, request.headers.get("X-Operation-ID")!)
      : new Response(null, { status: 404 });
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
            level: cause instanceof SocialError && cause.status < 500 ? "warn" : "error",
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
        await images.process();
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
