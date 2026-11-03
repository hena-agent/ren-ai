import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { parsePersona } from "@ren-ai/personas";
import {
  socialAccount,
  socialTask,
  socialAuthAccount,
} from "../../../packages/onboarding/src/social.test-helper.ts";
import { socialBindings } from "./social/bindings.ts";
import { invitationAvailability } from "./social/invitation.ts";
import { invitations } from "./discovery/invitations.ts";
import { withContactDatabase } from "./discovery/contact.test-helper.ts";
import { notificationFixture } from "./discovery/notifications.test-helper.ts";
import type { ApplicationStore } from "./application-store.ts";
import { valid } from "../test/host.test-helper.ts";
import { executionBindings } from "../test/execution-bindings.ts";

test("social execution loads the selected private Persona, uses existing invitation availability and forwards authenticated Mac commands", async () => {
  const persona = parsePersona("alice", valid);
  let records = [persona];
  const requests: Request[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname === "/api/catalog")
      return Response.json({
        revision: "one",
        personas: records.map((entry) => ({ persona: entry, state: "", memory: "" })),
      });
    if (new URL(request.url).pathname === "/social/browser")
      return Response.json({ text: "public result" });
    return new Response(null, { status: 202 });
  });
  const application = vi.fn<(request: Request) => Promise<Response>>(async () =>
    Response.json({ available: true }),
  );
  const env = {
    ...executionBindings,
    TOKEN_MANAGEMENT: "secret",
  };
  const binding = socialBindings(env, "rules", application, fetcher);
  expect(
    socialBindings(
      { PERSONA_CATALOG_URL: env.PERSONA_CATALOG_URL, API_MSG_URL: env.API_MSG_URL },
      "rules",
      application,
      fetcher,
    ).token,
  ).toBe("");
  expect(await binding.personas()).toEqual(new Set(["alice"]));
  expect(await binding.invitation("SOCIAL20")).toBe(true);
  const task = socialTask();
  await binding.start(task.run, task.account);
  const submitted = requests.find((request) => new URL(request.url).pathname === "/social/runs")!;
  expect(new URL(submitted.url).origin).toBe(env.API_MSG_URL);
  const body = Schema.decodeUnknownSync(Schema.Struct({ snapshot: Schema.String }))(
    await submitted.json(),
  );
  expect(body.snapshot).toContain('"id":"alice"');
  expect(submitted.headers.get("authorization")).toBe("Bearer secret");
  await binding.cancel("first", "run-1");
  await binding.open("first", "x");
  expect(
    await binding.browser(task.run, socialAccount, { kind: "notifications" }, "action-1"),
  ).toEqual({ text: "public result" });
  application.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(binding.invitation("SOCIAL20")).rejects.toThrow("availability is unavailable");
  records = [];
  await expect(binding.start(task.run, task.account)).rejects.toThrow("no longer exists");
  for (const origin of [
    "http://remote.test",
    "https://user:secret@social.test",
    "https://social.test/path",
    "https://social.test?token=bad",
  ]) {
    const options = socialBindings({ ...env, API_MSG_URL: origin }, "rules", application, fetcher);
    await expect(options.open("first", "x")).rejects.toThrow("API_MSG_URL must be");
  }
  const local = socialBindings(
    { ...env, API_MSG_URL: "http://localhost:4700" },
    "rules",
    application,
    fetcher,
  );
  await local.open("first", "x");
  fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(local.open("first", "x")).rejects.toMatchObject({
    code: "SOCIAL_EXECUTOR_UNAVAILABLE",
    upstreamStatus: 503,
  });
  fetcher.mockRejectedValue(
    Object.assign(new Error("PRIVATE_NETWORK_FAILURE"), { code: "ECONNREFUSED" }),
  );
  await expect(local.open("first", "x")).rejects.toMatchObject({
    code: "SOCIAL_EXECUTOR_UNAVAILABLE",
    cause: { code: "ECONNREFUSED" },
  });
});

test("exact invitation checks use the existing durable ledger, including codes outside the recent listing", () =>
  withContactDatabase(
    Effect.gen(function* () {
      yield* notificationFixture;
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* invitations;
      yield* ledger.create({
        code: "SOCIAL20",
        requestId: crypto.randomUUID(),
        maxUses: 1,
        grantCount: 0,
      });
      const store = fromPartial<ApplicationStore>({
        run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
          Effect.runPromise(effect.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
      });
      const call = (code: string, token = "secret", method = "GET") =>
        invitationAvailability(
          new Request(`https://app/management/invitation-availability?code=${code}`, {
            method,
            headers: { Authorization: `Bearer ${token}` },
          }),
          store,
          "secret",
        );
      yield* Effect.promise(async () => {
        expect((await call("SOCIAL20", "wrong")).status).toBe(401);
        expect((await call("SOCIAL20", "secret", "POST")).status).toBe(405);
        expect((await call("bad%20code")).status).toBe(400);
        expect(await (await call("SOCIAL20")).json()).toEqual({ available: true });
        expect(await (await call("missing")).json()).toEqual({ available: false });
      });
      yield* sql`UPDATE invitation SET used_count=1 WHERE token='SOCIAL20'`;
      yield* Effect.promise(async () =>
        expect(await (await call("SOCIAL20")).json()).toEqual({ available: false }),
      );
    }).pipe(Effect.scoped),
  ));

test("authentication transport validates status and only classifies proven pre-submit failures as blocked", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ state: "logging_in", hasCredentials: true }),
  );
  const binding = socialBindings(executionBindings, "rules", async () => new Response(), fetcher);
  expect(await binding.authenticate(socialAuthAccount, { kind: "login" }, "auth-request")).toEqual({
    state: "logging_in",
    hasCredentials: true,
  });
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Operation-ID")).toBe(
    "auth-request",
  );
  fetcher.mockResolvedValue(Response.json({ private: "DO_NOT_ECHO" }));
  await expect(binding.authenticate(socialAuthAccount, { kind: "status" })).rejects.toMatchObject({
    status: 503,
    code: "SOCIAL_AUTH_RESPONSE_INVALID",
  });
  fetcher.mockResolvedValue(new Response(null, { status: 409 }));
  await expect(binding.authenticate(socialAuthAccount, { kind: "login" })).rejects.toMatchObject({
    status: 409,
    code: "SOCIAL_AUTH_CONFLICT",
  });
  const task = socialTask();
  fetcher.mockResolvedValue(
    Response.json(
      { error: "SOCIAL_AUTH_REQUIRED", status: { state: "code_required", hasCredentials: true } },
      { status: 423 },
    ),
  );
  await expect(
    binding.browser(task.run, task.account, { kind: "post", text: "Hello" }, "write"),
  ).rejects.toMatchObject({ status: 423, code: "SOCIAL_AUTH_REQUIRED" });
  fetcher.mockResolvedValue(Response.json({ error: "OTHER" }, { status: 423 }));
  await expect(
    binding.browser(task.run, task.account, { kind: "post", text: "Hello" }, "write"),
  ).rejects.toMatchObject({ status: 503, code: "SOCIAL_AUTH_RESPONSE_INVALID" });
});
