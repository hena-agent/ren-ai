import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { parsePersona } from "@ren-ai/personas";
import { socialAccount, socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
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
    if (new URL(request.url).pathname === "/browser")
      return Response.json({ text: "public result" });
    return new Response(null, { status: 202 });
  });
  const application = vi.fn<(request: Request) => Promise<Response>>(async () =>
    Response.json({ available: true }),
  );
  const env = {
    ...executionBindings,
    TOKEN_MANAGEMENT: "secret",
    SOCIAL_EXECUTOR_URL: "https://social.test",
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
  const submitted = requests.find((request) => new URL(request.url).pathname === "/runs")!;
  const body = Schema.decodeUnknownSync(Schema.Struct({ snapshot: Schema.String }))(
    await submitted.json(),
  );
  expect(body.snapshot).toContain('"id":"alice"');
  expect(submitted.headers.get("authorization")).toBe("Bearer secret");
  await binding.cancel("first", "run-1");
  await binding.open("first");
  expect(
    await binding.browser(task.run, socialAccount, { kind: "notifications" }, "action-1"),
  ).toEqual({ text: "public result" });
  application.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(binding.invitation("SOCIAL20")).rejects.toThrow("availability is unavailable");
  records = [];
  await expect(binding.start(task.run, task.account)).rejects.toThrow("no longer exists");
  for (const origin of [
    undefined,
    "http://remote.test",
    "https://user:secret@social.test",
    "https://social.test/path",
    "https://social.test?token=bad",
  ]) {
    const options = socialBindings(
      { ...env, ...(origin ? { SOCIAL_EXECUTOR_URL: origin } : { SOCIAL_EXECUTOR_URL: "" }) },
      "rules",
      application,
      fetcher,
    );
    await expect(options.open("first")).rejects.toThrow(
      origin ? "Invalid social executor" : "is required",
    );
  }
  const local = socialBindings(
    { ...env, SOCIAL_EXECUTOR_URL: "http://localhost:5407" },
    "rules",
    application,
    fetcher,
  );
  await local.open("first");
  fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  await expect(local.open("first")).rejects.toMatchObject({
    code: "SOCIAL_EXECUTOR_REQUEST",
    upstreamStatus: 503,
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
